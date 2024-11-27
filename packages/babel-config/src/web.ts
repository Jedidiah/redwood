import fs from 'fs'
import path from 'path'

import type { TransformOptions } from '@babel/core'

// This import is for types safety. Its just a type, no harm importing from src.
import type { PluginOptions as RoutesAutoLoaderOptions } from '@redwoodjs/babel-config/src/plugins/babel-plugin-redwood-routes-auto-loader'
import { getConfig, getPaths } from '@redwoodjs/project-config'

import type { RegisterHookOptions } from './common'
import {
  CORE_JS_VERSION,
  registerBabel,
  parseTypeScriptConfigFiles,
  getPathsFromTypeScriptConfig,
} from './common'

// These flags toggle on/off certain features
export interface Flags {
  forJest?: boolean // will change the alias for module-resolver plugin
  forPrerender?: boolean // changes what babel-plugin-redwood-routes-auto-loader does
  forJavaScriptLinting?: boolean // will enable presets to supporting linting in the absence of typescript related presets/plugins/parsers
}

export const getWebSideBabelPlugins = (
  { forJest }: Flags = { forJest: false },
) => {
  // Need the project config to know if trusted graphql documents is being used and decide to use
  // the gql tag import or the trusted document gql function generated by code gen client preset
  const config = getConfig()

  // The compiler config has both an enabled and lintOnly setting so we have to ensure
  // the user wants to do more than simply lint before enabling the plugin
  const useReactCompiler =
    config.experimental?.reactCompiler?.enabled &&
    config.experimental?.reactCompiler?.lintOnly === false

  const useTrustedDocumentsGqlTag = config.graphql.trustedDocuments

  const rwjsPaths = getPaths()
  // Get the TS configs in the api and web sides as an object
  const tsConfigs = parseTypeScriptConfigFiles()

  const plugins = [
    // It is important that this plugin run first, as noted here: https://react.dev/learn/react-compiler
    useReactCompiler && [
      'babel-plugin-react-compiler',
      {
        // No specific config at this time...
      },
    ],
    // === Import path handling
    [
      'babel-plugin-module-resolver',
      {
        alias: {
          src:
            // Jest monorepo and multi project runner is not correctly determining
            // the `cwd`: https://github.com/facebook/jest/issues/7359
            forJest ? rwjsPaths.web.src : './src',
          // adds the paths from [ts|js]config.json to the module resolver
          ...getPathsFromTypeScriptConfig(tsConfigs.web, rwjsPaths.web.base),
          $api: rwjsPaths.api.base,
        },
        root: [rwjsPaths.web.base],
        cwd: 'packagejson',
        loglevel: 'silent', // to silence the unnecessary warnings
      },
      'rwjs-module-resolver',
    ],
    [
      require('./plugins/babel-plugin-redwood-directory-named-import').default,
      undefined,
      'rwjs-directory-named-modules',
    ],

    // === Auto imports, and transforms
    [
      'babel-plugin-auto-import',
      {
        declarations: [
          {
            // import { React } from 'react'
            default: 'React',
            path: 'react',
          },
          // A project can turn on trusted graphql documents
          // If projects do not use trusted documents (default)
          // it auto-imports the gql tag from graphql-tag
          !useTrustedDocumentsGqlTag && {
            // import gql from 'graphql-tag'
            default: 'gql',
            path: 'graphql-tag',
          },
          // if projects use trusted documents
          // then it auto-imports the gql function from the generated codegen client preset
          useTrustedDocumentsGqlTag && {
            // import { gql } from 'src/graphql/gql'
            members: ['gql'],
            path: `web/src/graphql/gql`,
          },
        ].filter(Boolean),
      },
      'rwjs-web-auto-import',
    ],
    ['babel-plugin-graphql-tag', undefined, 'rwjs-babel-graphql-tag'],
    process.env.NODE_ENV !== 'development' && [
      require('./plugins/babel-plugin-redwood-remove-dev-fatal-error-page')
        .default,
      undefined,
      'rwjs-remove-dev-fatal-error-page',
    ],
  ].filter(Boolean) as TransformOptions[]

  return plugins
}

export const getWebSideOverrides = (
  { forPrerender }: Flags = { forPrerender: false },
): TransformOptions[] => {
  // Have to use a readonly array here because of a limitation in TS
  // See https://stackoverflow.com/a/70763406/88106
  const overrides: readonly (false | TransformOptions)[] = [
    {
      test: /.+Cell.(js|tsx|jsx)$/,
      plugins: [require('./plugins/babel-plugin-redwood-cell').default],
    },
    // Automatically import files in `./web/src/pages/*` in to
    // the `./web/src/Routes.[ts|jsx]` file.
    {
      test: /Routes.(js|tsx|jsx)$/,
      plugins: [
        [
          require('./plugins/babel-plugin-redwood-routes-auto-loader').default,
          // The plugin will modify the Routes file differently based on what
          // context we're building for
          {
            forPrerender,
          } satisfies RoutesAutoLoaderOptions,
          'babel-plugin-redwood-routes-auto-loader',
        ],
      ],
    },
    // ** Files ending in `Cell.mock.[js,ts]` **
    // Automatically determine keys for saving and retrieving mock data.
    // Only required for storybook and jest
    process.env.NODE_ENV !== 'production' && {
      test: /.+Cell.mock.(js|ts)$/,
      plugins: [
        require('./plugins/babel-plugin-redwood-mock-cell-data').default,
      ],
    },
  ]

  return overrides.filter(
    (override: false | TransformOptions): override is TransformOptions => {
      return !!override
    },
  )
}

export const getWebSideBabelPresets = (options: Flags) => {
  // When we perform prerendering we don't use vite, so we need to add the
  // appropriate presets for react, env, and typescript, etc.
  if (options.forPrerender || options.forJest || options.forJavaScriptLinting) {
    let reactPresetConfig: babel.PluginItem = { runtime: 'automatic' }

    // This is a special case, where @babel/preset-react needs config
    // And using extends doesn't work
    if (getWebSideBabelConfigPath()) {
      const userProjectConfig = require(getWebSideBabelConfigPath() as string)

      userProjectConfig.presets?.forEach(
        (preset: TransformOptions['presets']) => {
          // If it isn't a preset with special config ignore it
          if (!Array.isArray(preset)) {
            return
          }

          const [presetName, presetConfig] = preset
          if (presetName === '@babel/preset-react') {
            reactPresetConfig = presetConfig
          }
        },
      )
    }
    return [
      ['@babel/preset-react', reactPresetConfig],
      [
        '@babel/preset-env',
        {
          // the targets are set in <userProject>/web/package.json
          useBuiltIns: 'usage',
          corejs: {
            version: CORE_JS_VERSION,
            proposals: true,
          },
          exclude: [
            // Remove class-properties from preset-env, and include separately
            // https://github.com/webpack/webpack/issues/9708
            '@babel/plugin-transform-class-properties',
            '@babel/plugin-transform-private-methods',
          ],
        },
        'rwjs-babel-preset-env',
      ],
      ['@babel/preset-typescript', undefined, 'rwjs-babel-preset-typescript'],
    ]
  }

  return []
}

export const getWebSideBabelConfigPath = () => {
  const customBabelConfig = path.join(getPaths().web.base, 'babel.config.js')
  if (fs.existsSync(customBabelConfig)) {
    return customBabelConfig
  } else {
    return undefined
  }
}

export const getWebSideDefaultBabelConfig = (options: Flags = {}) => {
  // NOTE:
  // Even though we specify the config file, babel will still search for .babelrc
  // and merge them because we have specified the filename property, unless babelrc = false

  return {
    presets: getWebSideBabelPresets(options),
    plugins: getWebSideBabelPlugins(options),
    overrides: getWebSideOverrides(options),
    extends: getWebSideBabelConfigPath(),
    babelrc: false,
    ignore: ['node_modules'],
  }
}

// Used in prerender only currently
export const registerWebSideBabelHook = ({
  plugins = [],
  overrides = [],
  options = {},
}: RegisterHookOptions = {}) => {
  const defaultOptions = getWebSideDefaultBabelConfig(options)
  registerBabel({
    ...defaultOptions,
    root: getPaths().base,
    extensions: ['.js', '.ts', '.tsx', '.jsx'],
    plugins: [...defaultOptions.plugins, ...plugins],
    cache: false,
    // We only register for prerender currently
    // Static importing pages makes sense
    overrides: [...getWebSideOverrides({ forPrerender: true }), ...overrides],
  })
}