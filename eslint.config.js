// @ts-check

import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-plugin-prettier";
import eslintConfigPrettier from "eslint-config-prettier/flat";

export default [
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...tseslint.configs.strict,
  {
    files: ["**/*.ts"],
    plugins: {
      prettier,
    },
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "prettier/prettier": "error",
      "no-control-regex": "off",
      "require-await": "error",
      "no-restricted-syntax": [
        "error",
        {
          selector: "Literal[value=null]",
          message: "Use 'undefined' instead of 'null'.",
        },
        {
          selector:
            "TSPropertySignature > TSTypeAnnotation > TSUnionType > TSUndefinedKeyword",
          message:
            "Do not use explicit `| undefined` on interface or type properties. Use the optional operator `?` instead (e.g., `field?: Type`).",
        },
        {
          selector:
            ":not(VariableDeclarator) > Identifier > TSTypeAnnotation > TSUnionType > TSUndefinedKeyword",
          message:
            "Do not use explicit `| undefined` on parameters. Mark the parameter as optional instead (e.g., `param?: Type`).",
        },
        {
          selector:
            'BinaryExpression[operator=/[=!]==/] > Identifier[name="undefined"]',
          message: "Do not compare `undefined`, ie. `if (x === undefined)`. Use truthy instead `if (x)`",
        }
      ],
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/no-unnecessary-type-assertion": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  eslintConfigPrettier,
];
