#!/usr/bin/env bash
# Pruebas en memoria: nunca acceden a Docker, DB, contenedores ni red.
set -Eeuo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
bash scripts/restore-data.sh --help >/dev/null
python3 - <<'PY'
import contextlib, hashlib, io, pathlib, subprocess, tarfile, unittest
from unittest.mock import patch

source = pathlib.Path('scripts/restore-data.sh').read_text()
archive_code = source.split('prepare_archive() {', 1)[1].split("<<'PY'\n", 1)[1].split('\nPY\n', 1)[0]

class ArchiveTests(unittest.TestCase):
    def validate(self, members, checksum=None, raw=None):
        payload = io.BytesIO()
        with tarfile.open(fileobj=payload, mode='w:gz') as tar:
            for name, kind, data in members:
                info = tarfile.TarInfo(name)
                info.type = kind
                info.size = len(data) if kind == tarfile.REGTYPE else 0
                info.linkname = '../../escape' if kind in (tarfile.SYMTYPE, tarfile.LNKTYPE) else ''
                tar.addfile(info, io.BytesIO(data) if info.isfile() else None)
        raw = payload.getvalue() if raw is None else raw
        real_open = tarfile.open
        output = io.BytesIO()
        @contextlib.contextmanager
        def fake_open(path, mode):
            if mode == 'rb':
                yield io.BytesIO(raw)
            else:
                self.assertEqual(path, '/work/postgres.dump')
                self.assertEqual(mode, 'xb')
                yield output
        events = []
        def read_checksum(*args, **kwargs):
            self.assertEqual(events, ['copied'])
            if checksum is None:
                raise FileNotFoundError('sidecar disappeared or absent')
            return checksum(raw)
        status = io.StringIO()
        with contextlib.redirect_stdout(status), \
             patch('sys.argv', ['validator', '/backup.tar.gz', '/work']), \
             patch('shutil.copyfile', side_effect=lambda *a: events.append('copied')), \
             patch('pathlib.Path.read_text', side_effect=read_checksum), \
             patch('builtins.open', fake_open), \
             patch('tarfile.open', side_effect=lambda *a, **kw: real_open(fileobj=io.BytesIO(raw), mode='r:gz')):
            exec(compile(archive_code, 'archive-validator', 'exec'), {})
        self.assertEqual(status.getvalue(), 'missing\n' if checksum is None else '')
        return output.getvalue()

    def test_safety_archive_round_trip(self):
        package_code = source.split('package_safety_archive() {', 1)[1].split("<<'PY'\n", 1)[1].split('\nPY\n', 1)[0]
        dump = b'PGDMPsafety-data'
        payload = io.BytesIO()
        real_open = tarfile.open
        with patch('sys.argv', ['packager', '/safety.dump', '/safety.tar.gz']), \
             patch('builtins.open', return_value=io.BytesIO(dump)), \
             patch('os.path.getsize', return_value=len(dump)), \
             patch('tarfile.open', side_effect=lambda *a, **kw: real_open(fileobj=payload, mode='w:gz')):
            exec(compile(package_code, 'safety-packager', 'exec'), {})
        self.assertEqual(self.validate([], raw=payload.getvalue()), dump)

    def test_nested_dump_sql_empty_uploads(self):
        self.assertEqual(self.validate([
            ('backup/postgres.dump', tarfile.REGTYPE, b'PGDMPdata'),
            ('backup/postgres.sql', tarfile.REGTYPE, b'SELECT 1;'),
            ('backup/uploads', tarfile.DIRTYPE, b''),
        ]), b'PGDMPdata')

    def test_unsafe_members(self):
        for name, kind in [('../escape', tarfile.REGTYPE), ('/escape', tarfile.REGTYPE),
                           ('backup/../../escape', tarfile.REGTYPE), ('backup/link', tarfile.SYMTYPE),
                           ('backup/hard', tarfile.LNKTYPE), ('backup/device', tarfile.CHRTYPE),
                           ('backup/uploads/empty.txt', tarfile.REGTYPE)]:
            with self.subTest(name=name), self.assertRaises(SystemExit):
                self.validate([('backup/postgres.dump', tarfile.REGTYPE, b'PGDMP'), (name, kind, b'')])

    def test_missing_duplicate_invalid_dump(self):
        for members in [[], [('b/postgres.dump', tarfile.REGTYPE, b'SQL')],
                        [('a/postgres.dump', tarfile.REGTYPE, b'PGDMP'), ('b/postgres.dump', tarfile.REGTYPE, b'PGDMP')],
                        [('b/postgres.dump', tarfile.REGTYPE, b'PGDMP')] * 2]:
            with self.subTest(members=members), self.assertRaises(SystemExit):
                self.validate(members)

    def test_checksums(self):
        dump = [('postgres.dump', tarfile.REGTYPE, b'PGDMP')]
        self.validate(dump, lambda raw: hashlib.sha256(raw).hexdigest() + '  backup.tar.gz')
        for checksum in ['0' * 64, 'malformed', '0' * 64 + '  other.tar.gz', '0' * 64 + '\n' + '0' * 64]:
            with self.subTest(checksum=checksum), self.assertRaises(SystemExit):
                self.validate(dump, lambda raw: checksum)

class ShellTests(unittest.TestCase):
    def shell(self, body, stdin=''):
        return subprocess.run(['bash', '-c', 'source scripts/restore-data.sh\n' + body],
                              input=stdin, text=True, capture_output=True)

    def test_missing_or_disappeared_sidecar_requires_acceptance(self):
        # Mock only the Python validator: no archive or temporary files are written.
        body = '''
ARCHIVE=/selected.tar.gz WORK_DIR=/frozen
python3() { printf 'missing\\n'; }
prepare_archive
'''
        for answer in ('', '\n', 'n\n'):
            result = self.shell(body, answer)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('Cancelado sin checksum', result.stderr)
        self.assertEqual(self.shell(body, 's\n').returncode, 0)
        self.assertEqual(self.shell(body.replace("printf 'missing\\n'", ':'), '').returncode, 0)
        self.assertNotEqual(self.shell(body.replace("printf 'missing\\n'", 'return 7'), 's\n').returncode, 0)
        self.assertNotIn('[[ -f "$ARCHIVE.sha256" ]]', source)

    def test_exact_custom_validation_without_database_connection(self):
        body = '''
db() { printf 'MOCK %s\\n' "$*" >&2; }
validate_custom_dump /dev/null
'''
        result = self.shell(body)
        self.assertEqual(result.returncode, 0)
        self.assertIn('pg_restore --list', result.stderr)
        self.assertIn('--exit-on-error --no-owner --no-privileges --file=/dev/null', result.stderr)
        self.assertNotIn(' -d ', result.stderr)
        for failure in ('--list', '--exit-on-error'):
            result = self.shell(body.replace('printf', f'[[ "$2" != {failure} ]] || return 9; printf'))
            self.assertNotEqual(result.returncode, 0)
        self.assertIn('validate_custom_dump "$WORK_DIR/postgres.dump"', source)
        self.assertIn('validate_custom_dump "$safety_path"', source)
        self.assertIn('NO valida este postgres.dump', source)
        self.assertLess(source.index('validate_custom_dump "$WORK_DIR/postgres.dump"'), source.index('QUIESCED=1'))

    def test_default_no(self):
        for answer in ('\n', 'yes\n', ''):
            self.assertNotEqual(self.shell("confirm prueba", answer).returncode, 0)
        self.assertEqual(self.shell('confirm prueba', 's\n').returncode, 0)

    def test_fail_closed_die_error_and_signals(self):
        for ending in ('die prueba', 'false', 'kill -TERM $$', 'kill -INT $$', 'kill -HUP $$'):
            result = self.shell('''
WORK_DIR='' QUIESCED=1
compose() { printf 'MOCK %s\\n' "$*" >&2; }
trap cleanup EXIT
trap 'exit 1' ERR
trap 'exit 143' TERM
trap 'exit 130' INT
trap 'exit 129' HUP
''' + ending)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('Web debe quedar detenida', result.stderr)
            self.assertNotIn('start web', result.stderr)

    def test_preflight_failure_does_not_stop_web(self):
        result = self.shell("WORK_DIR='' QUIESCED=0; compose() { exit 99; }; trap cleanup EXIT; die prueba")
        self.assertEqual(result.returncode, 1)
        self.assertNotIn('Web debe', result.stderr)

    def test_target_and_order_guards(self):
        # El script es DB-only y no inicia dependencias. Un `compose up` pelado
        # arrastraría migrate y seed por el grafo de `web`, así que cada uno
        # tiene que llevar --no-deps. La garantía es la misma que antes; lo que
        # cambia es que ahora se exige la forma segura en lugar de prohibir el
        # comando entero.
        ups = [line for line in source.splitlines() if 'compose up' in line]
        self.assertTrue(ups)
        for line in ups:
            self.assertIn('--no-deps', line)
        self.assertNotIn('down -v', source)
        self.assertIn('pg_restore --exit-on-error', source)
        self.assertIn("<<'SQL'", source)
        self.assertIn('DROP DATABASE :"target" WITH (FORCE);', source)
        self.assertLess(source.index('prepare_archive\n'), source.index('QUIESCED=1'))
        self.assertLess(source.index('pg_dump -U'), source.index('DROP DATABASE'))
        compact = ''.join(source.split())
        # El orden se mantiene: las tablas se verifican ANTES de devolver web a
        # servicio. Arrancarla sobre una restauración sin verificar expondría
        # una base que nadie comprobó.
        self.assertLess(compact.index('((tables>0))'), compact.index('restore_web_state'))
        self.assertLess(source.index('package_safety_archive "$safety_path"'), source.index('DROP DATABASE'))
        self.assertIn('|| die "Falló el empaquetado;', source)
        self.assertIn('if [[ "$WEB_STATE" == running ]]; then', source)
        # `compose start` no ejecuta los jobs one-shot del grafo, así que con
        # web dependiendo de seed y seed de migrate, compose aborta con
        # "seed is missing dependency migrate" y deja web detenida tras una
        # restauración que sí terminó bien. Reproducido el 30/10/2026.
        self.assertNotIn('compose start web', source)
        self.assertIn('i<60', compact)
        self.assertIn('SIN RESPALDO', source)

unittest.main(verbosity=2)
PY

# --------------------------------------------------------------------------
# Devolver `web` a servicio, con `compose` y `docker` stubeados. Se prueba qué
# comandos invoca, no el texto del script: un grep demostraría que la cadena
# está, no que el arranque funciona.
# --------------------------------------------------------------------------
web_state_body="$(sed -n '/^restore_web_state() {/,/^}/p' scripts/restore-data.sh)"
[ -n "$web_state_body" ] || {
  printf 'ERROR: restore-data.sh no define restore_web_state()\n' >&2
  exit 1
}

run_web_state() {
  (
    CALLS=''
    # Las consume `restore_web_state`, que entra por `eval` más abajo: el
    # análisis estático no puede verlo, pero quitarlas rompe la prueba.
    # shellcheck disable=SC2034
    WEB_STATE="$1"
    # shellcheck disable=SC2034
    WEB_ID=contenedor-falso
    compose() { CALLS="$CALLS|compose $*"; }
    docker() { printf 'running/healthy'; }
    die() {
      CALLS="$CALLS|die $*"
      return 1
    }
    eval "$web_state_body"
    restore_web_state >/dev/null 2>&1 || true
    printf '%s' "$CALLS"
  )
}

web_failures=0
web_check() {
  if [ "$2" = "$3" ]; then
    printf '  ok   %s\n' "$1"
  else
    printf '  FAIL %s — esperado "%s", obtenido "%s"\n' "$1" "$2" "$3" >&2
    web_failures=$((web_failures + 1))
  fi
}

printf '\n== restore_web_state ==\n'
running_calls="$(run_web_state running)"

# `--no-deps` es el punto: sin él, compose intenta satisfacer web -> seed ->
# migrate y aborta porque esos jobs one-shot no están en un estado válido.
web_check 'levanta web sin resolver el grafo de dependencias' \
  si "$(case "$running_calls" in *'--no-deps'*) printf si ;; *) printf no ;; esac)"

# `--no-recreate` es tan necesario como `--no-deps`, y por una razón que no se
# ve leyendo este script: `docker-compose.yml` resuelve APP_COMMIT a `unknown`
# cuando nadie lo exporta, y `deploy.sh` lo exporta pero una restauración
# invocada aparte no. Para compose eso es un cambio de configuración, así que
# RECREA el contenedor —`--no-deps` no lo impide—. El WEB_ID capturado antes de
# restaurar queda apuntando a un contenedor eliminado, `docker inspect` falla y
# el trap de limpieza detiene el reemplazo: la app queda caída después de una
# restauración exitosa.
web_check 'preserva el contenedor existente en lugar de recrearlo' \
  si "$(case "$running_calls" in *'--no-recreate'*) printf si ;; *) printf no ;; esac)"

web_check 'no usa compose start, que no ejecuta los jobs del grafo' \
  no "$(case "$running_calls" in *'compose start'*) printf si ;; *) printf no ;; esac)"

# El script promete en su propia ayuda que no ejecuta migrate ni seed: el dump
# restaurado trae su esquema y migrar acá lo pisaría.
web_check 'no ejecuta migrate' \
  no "$(case "$running_calls" in *migrate*) printf si ;; *) printf no ;; esac)"

web_check 'no ejecuta seed' \
  no "$(case "$running_calls" in *seed*) printf si ;; *) printf no ;; esac)"

# Si web estaba detenida antes de restaurar, se conserva ese estado: devolverla
# a servicio por iniciativa propia cambiaría la disponibilidad sin que nadie lo
# pidiera.
web_check 'web detenida: no la arranca' \
  '' "$(run_web_state exited)"

if ((web_failures > 0)); then
  printf '\n%s prueba(s) de arranque fallaron.\n' "$web_failures" >&2
  exit 1
fi
printf '\nArranque de web verificado.\n'
