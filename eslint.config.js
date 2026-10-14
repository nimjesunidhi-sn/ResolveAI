import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/node_modules/**", "client/tsconfig.tsbuildinfo"] },
  ...tseslint.configs.recommended,
  {
    files: ["client/src/**/*.{ts,tsx}"],
    languageOptions: { globals: { ...globals.browser, ...globals.es2021 } },
    plugins: { "react-hooks": reactHooks },
    rules: { ...reactHooks.configs.flat.recommended.rules, "react-hooks/set-state-in-effect": "off", "@typescript-eslint/no-explicit-any": "off" }
  },
  {
    files: ["server/src/**/*.ts", "server/tests/**/*.mjs", "client/**/*.js"],
    languageOptions: { globals: { ...globals.node, ...globals.es2021 } },
    rules: { "@typescript-eslint/no-explicit-any": "off" }
  },
  {
    files: ["server/tests/**/*.mjs"],
    rules: { "no-undef": "error", "no-unused-vars": "warn" }
  }
);
