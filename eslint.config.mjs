import importPlugin from 'eslint-plugin-import'
import simpleImportSort from 'eslint-plugin-simple-import-sort'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['build/**', 'node_modules/**'] },
  {
    languageOptions: {
      globals: { ...globals.node }
    }
  },
  tseslint.configs.recommended,
  {
    plugins: { import: importPlugin, 'simple-import-sort': simpleImportSort },
    rules: {
      semi: ['error', 'never'],
      'space-before-function-paren': ['error', { named: 'never', asyncArrow: 'always', anonymous: 'always' }],
      'no-empty-function': 'off',
      '@typescript-eslint/no-empty-function': 'off',
      'class-methods-use-this': 'off',
      'default-case': 'warn',
      'no-new': 'warn',
      '@typescript-eslint/no-shadow': 'warn',
      'no-invalid-this': 'warn',
      'no-useless-constructor': 'warn',
      'import/no-deprecated': 'error',
      'import/order': 'off',
      'simple-import-sort/imports': 'error',
      'simple-import-sort/exports': 'error',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
      '@typescript-eslint/no-shadow': 'off',
      'no-console': 'warn'
    }
  },
  {
    files: ['**/*.js'],
    rules: {
      '@typescript-eslint/no-require-imports': 'off'
    }
  }
)
