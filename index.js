'use strict'

const through = require('through2')
const gutil = require('gulp-util')
const PluginError = gutil.PluginError
const format = require('prettier-eslint')
const applySourceMap = require('vinyl-sourcemaps-apply')

function gulpPrettierEslint (opts = {}) {
  return through.obj(function (file, enc, cb) {
    if (file.isNull()) {
      return cb(null, file)
    }

    if (file.isStream()) {
      return callback(
        new PluginError('gulp-prettier-eslint', 'Streaming not supported')
      )
    }

    let result
    const text = file.contents.toString('utf8')

    try {
      result = format(Object.assign(opts, { text }))
    } catch (error) {
      return callback(new PluginError('gulp-prettier-eslint', error))
    }

    if (result && result.v3SourceMap && file.sourceMap) {
      applySourceMap(file, result.v3SourceMap)
      file.contents = new Buffer(result.js)
    } else {
      file.contents = new Buffer(result)
    }

    file.contents = new Buffer(result)
    cb(null, file)
  })
}

module.exports = gulpPrettierEslint
