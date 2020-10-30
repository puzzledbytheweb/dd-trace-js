'use strict'

const semver = require('semver')
const hook = require('require-in-the-middle')
const parse = require('module-details-from-path')
const path = require('path')
const uniq = require('lodash.uniq')
const log = require('../../log')

const pathSepExpr = new RegExp(`\\${path.sep}`, 'g')

class Loader {
  constructor (instrumenter) {
    this._instrumenter = instrumenter
  }

  reload (plugins) {
    this._plugins = plugins

    const instrumentations = Array.from(this._plugins.keys())
      .reduce((prev, current) => prev.concat(current), [])

    const instrumentedModules = uniq(instrumentations
      .map(instrumentation => instrumentation.name))

    this._names = new Set(instrumentations
      .map(instrumentation => filename(instrumentation)))

    hook(instrumentedModules, { internals: true }, this._hookModule.bind(this, false))
  }

  preload (plugins) {
    this._preplugins = plugins
    const instrumentations = Array.from(this._plugins.keys())
      .reduce((prev, current) => prev.concat(current), [])

    const instrumentedModules = uniq(instrumentations
      .map(instrumentation => instrumentation.name))

    this._prenames = new Set(instrumentations
      .map(instrumentation => filename(instrumentation)))

    hook(instrumentedModules, { internals: true }, this._hookModule.bind(this, true))
  }

  load (instrumentation, config) {
    this._getModules(instrumentation).forEach(nodule => {
      this._instrumenter.patch(instrumentation, nodule, config)
    })
  }

  _getModules (instrumentation) {
    const modules = []
    const ids = Object.keys(require.cache)

    let pkg

    for (let i = 0, l = ids.length; i < l; i++) {
      const id = ids[i].replace(pathSepExpr, '/')

      if (!id.includes(`/node_modules/${instrumentation.name}/`)) continue

      if (instrumentation.file) {
        if (!id.endsWith(`/node_modules/${filename(instrumentation)}`)) continue

        const basedir = getBasedir(ids[i])

        pkg = require(`${basedir}/package.json`)
      } else {
        const basedir = getBasedir(ids[i])

        pkg = require(`${basedir}/package.json`)

        const mainFile = path.posix.normalize(pkg.main || 'index.js')
        if (!id.endsWith(`/node_modules/${instrumentation.name}/${mainFile}`)) continue
      }

      if (!matchVersion(pkg.version, instrumentation.versions)) continue

      modules.push(require.cache[ids[i]].exports)
    }

    return modules
  }

  _hookModule (isPreload, moduleExports, moduleName, moduleBaseDir) {
    moduleName = moduleName.replace(pathSepExpr, '/')

    if (!(isPreload ? this._prenames : this._names).has(moduleName)) {
      return moduleExports
    }

    if (moduleBaseDir) {
      moduleBaseDir = moduleBaseDir.replace(pathSepExpr, '/')
    }

    const moduleVersion = getVersion(moduleBaseDir)

    const plugins = isPreload ? this._preplugins : this._plugins

    Array.from(plugins.keys())
      .filter(plugin => [].concat(plugin).some(instrumentation =>
        filename(instrumentation) === moduleName && matchVersion(moduleVersion, instrumentation.versions)
      ))
      .forEach(plugin => this._validate(plugins, plugin, moduleName, moduleBaseDir, moduleVersion))

    plugins
      .forEach((meta, plugin) => {
        try {
          [].concat(plugin)
            .filter(instrumentation => moduleName === filename(instrumentation))
            .filter(instrumentation => matchVersion(moduleVersion, instrumentation.versions))
            .forEach(instrumentation => {
              const config = plugins.get(plugin).config

              if (isPreload) {
                moduleExports = this._instrumenter.patch(instrumentation, moduleExports, config) || moduleExports
              } else if (this._instrumenter.prepatch) {
                moduleExports = this._instrumenter.prepatch(instrumentation, moduleExports) || moduleExports
              }
            })
        } catch (e) {
          log.error(e)
          this._instrumenter.unload(plugin)
          log.debug(`Error while trying to patch ${meta.name}. The plugin has been disabled.`)
        }
      })

    return moduleExports
  }

  _validate (plugins, plugin, moduleName, moduleBaseDir, moduleVersion) {
    const meta = plugins.get(plugin)
    const instrumentations = [].concat(plugin)

    for (let i = 0; i < instrumentations.length; i++) {
      if (moduleName.indexOf(instrumentations[i].name) !== 0) continue
      if (instrumentations[i].versions && !matchVersion(moduleVersion, instrumentations[i].versions)) continue
      if (instrumentations[i].file && !exists(moduleBaseDir, instrumentations[i].file)) {
        this._instrumenter.unload(plugin)
        log.debug([
          `Plugin "${meta.name}" requires "${instrumentations[i].file}" which was not found.`,
          `The plugin was disabled.`
        ].join(' '))
        break
      }
    }
  }
}

function getBasedir (id) {
  return parse(id).basedir.replace(pathSepExpr, '/')
}

function matchVersion (version, ranges) {
  return !version || (ranges && ranges.some(range => semver.satisfies(semver.coerce(version), range)))
}

function getVersion (moduleBaseDir) {
  if (moduleBaseDir) {
    const packageJSON = `${moduleBaseDir}/package.json`
    return require(packageJSON).version
  }
}

function filename (plugin) {
  return [plugin.name, plugin.file].filter(val => val).join('/')
}

function exists (basedir, file) {
  try {
    require.resolve(`${basedir}/${file}`)
    return true
  } catch (e) {
    return false
  }
}

module.exports = Loader
