import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
  // CommonJS 构建脚本（.cjs）使用 require 是语言规范行为，不适用 ESM 规则
  {
    files: ["**/*.cjs"],
    rules: {
      "@typescript-eslint/no-require-imports": "off",
    },
  },
  // Application 层禁止直接读取 process.env（Spec 034 硬约束）
  // 配置应由 Composition/Presentation 层注入
  {
    files: ["src/application/**/*.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "MemberExpression[object.name='process'][property.name='env']",
          message:
            "Application 层不得直接读取 process.env，配置应由 Composition/Presentation 层注入（Spec 034）",
        },
      ],
    },
  },
]);

export default eslintConfig;
