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
        self.assertNotIn('compose up', source)
        self.assertNotIn('down -v', source)
        self.assertIn('pg_restore --exit-on-error', source)
        self.assertIn("<<'SQL'", source)
        self.assertIn('DROP DATABASE :"target" WITH (FORCE);', source)
        self.assertLess(source.index('prepare_archive\n'), source.index('QUIESCED=1'))
        self.assertLess(source.index('pg_dump -U'), source.index('DROP DATABASE'))
        compact = ''.join(source.split())
        self.assertLess(compact.index('((tables>0))'), compact.index('composestartweb'))
        self.assertLess(source.index('package_safety_archive "$safety_path"'), source.index('DROP DATABASE'))
        self.assertIn('|| die "Falló el empaquetado;', source)
        self.assertIn('if [[ "$WEB_STATE" == running ]]; then', source)
        self.assertIn('i<60', compact)
        self.assertIn('SIN RESPALDO', source)

unittest.main(verbosity=2)
PY
