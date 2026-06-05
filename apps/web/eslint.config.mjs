import next from "eslint-config-next";

// eslint-config-next@16 ya exporta un flat config nativo (Linter.Config[]).
// Se consume directo (sin FlatCompat).
const eslintConfig = [
  ...next,
  {
    ignores: [
      ".next/**",
      "node_modules/**",
      "lib/generated/**",
      "next-env.d.ts",
    ],
  },
];

export default eslintConfig;
