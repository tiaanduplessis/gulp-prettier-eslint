'use strict'

// Isolated stream contract tests: the formatter and PluginError are controlled
// doubles. This does not exercise the legacy formatter/Jest dependency graph.
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const vm = require('vm')
const Stream = require('stream')
const through = require(process.env.GULP_PRETTIER_ESLINT_STREAM_MODULE || 'through2')
const source = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8')
let passed = 0

function PluginError (plugin, error) {
  this.name = 'PluginError'
  this.plugin = plugin
  this.message = typeof error === 'string' ? error : error.message
  this.originalError = error
}
PluginError.prototype = Object.create(Error.prototype)
PluginError.prototype.constructor = PluginError

function load (formatter) {
  const module = { exports: {} }
  const dependencies = {
    through2: through,
    'gulp-util': { PluginError },
    'prettier-eslint': formatter,
    'vinyl-sourcemaps-apply': function () {
      throw new Error('String formatter results must not apply a source map')
    }
  }
  const wrapped = vm.runInThisContext('(function (require, module, exports) {\n' + source + '\n})', { filename: 'index.js' })
  wrapped(function (name) {
    assert(Object.prototype.hasOwnProperty.call(dependencies, name), name)
    return dependencies[name]
  }, module, module.exports)
  return module.exports
}

// Precise doubles for the three Vinyl members read by index.js. Real Buffer and
// Readable instances provide contents; arbitrary metadata verifies identity.
function file (contents) {
  return {
    contents,
    path: '/fixtures/input.js',
    metadata: {},
    isNull: function () { return this.contents === null },
    isStream: function () { return this.contents instanceof Stream.Readable }
  }
}

function collect (stream, files) {
  return new Promise(function (resolve, reject) {
    const output = []
    const writes = []
    let finished = false
    let ended = false
    const timer = setTimeout(function () { reject(new Error('Stream did not complete')) }, 2000)
    function done () {
      if (finished && ended) {
        clearTimeout(timer)
        resolve({ output, writes })
      }
    }
    stream.on('error', function (error) { clearTimeout(timer); reject(error) })
    stream.on('data', function (item) { output.push(item) })
    stream.on('finish', function () { finished = true; done() })
    stream.on('end', function () { ended = true; done() })
    files.forEach(function (item, index) {
      stream.write(item, function (error) {
        if (error) return reject(error)
        writes.push(index)
      })
    })
    stream.end()
  })
}

function check (name, run) {
  return Promise.resolve().then(run).then(function () {
    passed += 1
    console.log('ok ' + passed + ' - ' + name)
  })
}

function checkError (stream, input, message, original) {
  return new Promise(function (resolve, reject) {
    const errors = []
    const outputs = []
    const callbacks = []
    stream.on('error', function (error) { errors.push(error) })
    stream.on('data', function (output) { outputs.push(output) })
    try {
      stream.write(input, function (error) { callbacks.push(error) })
    } catch (error) {
      reject(error)
      return
    }
    setImmediate(function () {
      try {
        assert.strictEqual(errors.length, 1)
        assert.strictEqual(callbacks.length, 1)
        assert.strictEqual(outputs.length, 0)
        assert.strictEqual(callbacks[0], errors[0])
        assert(errors[0] instanceof PluginError)
        assert.strictEqual(errors[0].plugin, 'gulp-prettier-eslint')
        assert.strictEqual(errors[0].message, message)
        assert.strictEqual(errors[0].originalError, original)
        stream.destroy()
        resolve()
      } catch (error) { reject(error) }
    })
  })
}

check('empty stream completes without formatting', function () {
  return collect(load(function () { throw new Error('Unexpected format') })(), []).then(function (result) {
    assert.deepStrictEqual(result.output, [])
  })
}).then(function () {
  return check('null files retain identity and bypass formatting', function () {
    const input = file(null)
    return collect(load(function () { throw new Error('Unexpected format') })(), [input]).then(function (result) {
      assert.strictEqual(result.output[0], input)
      assert.strictEqual(input.contents, null)
      assert.deepStrictEqual(result.writes, [0])
    })
  })
}).then(function () {
  return check('buffer files preserve order, metadata, UTF-8 and options', function () {
    const options = { prettierOptions: { semi: false }, eslintConfig: { rules: {} } }
    const inputs = [file(Buffer.from('héllo')), file(null), file(Buffer.from('second'))]
    const map = { version: 3, sources: ['input.js'], mappings: '' }
    inputs[0].sourceMap = map
    const metadata = inputs.map(function (item) { return item.metadata })
    const calls = []
    const plugin = load(function (received) {
      assert.strictEqual(received, options)
      assert.strictEqual(received.prettierOptions, options.prettierOptions)
      assert.strictEqual(received.eslintConfig, options.eslintConfig)
      calls.push(received.text)
      return received.text === 'second' ? '' : 'formatted café\n'
    })
    return collect(plugin(options), inputs).then(function (result) {
      assert.strictEqual(result.output.length, inputs.length)
      inputs.forEach(function (input, index) {
        assert.strictEqual(result.output[index], input)
        assert.strictEqual(input.metadata, metadata[index])
        assert.strictEqual(input.path, '/fixtures/input.js')
      })
      assert.deepStrictEqual(calls, ['héllo', 'second'])
      assert.deepStrictEqual(result.writes, [0, 1, 2])
      assert(Buffer.isBuffer(inputs[0].contents))
      assert.strictEqual(inputs[0].contents.toString('utf8'), 'formatted café\n')
      assert(Buffer.isBuffer(inputs[2].contents))
      assert.strictEqual(inputs[2].contents.length, 0)
      assert.strictEqual(inputs[0].sourceMap, map)
      assert.strictEqual(options.text, 'second')
    })
  })
}).then(function () {
  return check('default options and separate plugin instances work', function () {
    const plugin = load(function (options) { return options.text.toUpperCase() })
    return Promise.all([collect(plugin(), [file(Buffer.from('one'))]), collect(plugin(), [file(Buffer.from('two'))])]).then(function (results) {
      assert.strictEqual(results[0].output[0].contents.toString(), 'ONE')
      assert.strictEqual(results[1].output[0].contents.toString(), 'TWO')
    })
  })
}).then(function () {
  return check('backpressure beyond 16 objects preserves 80 files exactly once', function () {
    const inputs = Array.from({ length: 80 }, function (_, index) { return file(Buffer.from(String(index))) })
    const calls = []
    const stream = load(function (options) { calls.push(options.text); return options.text })()
    assert.strictEqual(stream._readableState.objectMode, true)
    assert.strictEqual(stream._writableState.objectMode, true)
    assert.strictEqual(stream._readableState.highWaterMark, 16)
    const outputs = []
    const callbacks = []
    let backpressure = false
    return new Promise(function (resolve, reject) {
      const timer = setTimeout(function () { reject(new Error('Backpressure stream did not complete')) }, 2000)
      stream.on('error', reject)
      inputs.forEach(function (input, index) {
        if (!stream.write(input, function (error) {
          if (error) return reject(error)
          callbacks.push(index)
        })) backpressure = true
      })
      assert(backpressure)
      assert(calls.length < inputs.length)
      stream.on('data', function (output) { outputs.push(output) })
      stream.on('end', function () {
        setImmediate(function () {
          try {
            clearTimeout(timer)
            assert.strictEqual(outputs.length, 80)
            outputs.forEach(function (output, index) {
              assert.strictEqual(output, inputs[index])
              assert.strictEqual(output.contents.toString(), String(index))
            })
            assert.deepStrictEqual(calls, inputs.map(function (_, index) { return String(index) }))
            assert.deepStrictEqual(callbacks.slice().sort(function (a, b) { return a - b }), inputs.map(function (_, index) { return index }))
            resolve()
          } catch (error) { reject(error) }
        })
      })
      stream.end()
    })
  })
}).then(function () {
  return check('stream contents report one PluginError without calling formatter', function () {
    const readable = new Stream.Readable({ read: function () {} })
    const input = file(readable)
    const stream = load(function () { throw new Error('Unexpected format') })()
    return checkError(stream, input, 'Streaming not supported', 'Streaming not supported').then(function () {
      assert.strictEqual(input.contents, readable)
      readable.destroy()
    })
  })
}).then(function () {
  return check('formatter failures propagate once and preserve input contents', function () {
    const original = new Error('formatter failed')
    const input = file(Buffer.from('invalid input'))
    const contents = input.contents
    let calls = 0
    const stream = load(function () { calls += 1; throw original })()
    return checkError(stream, input, original.message, original).then(function () {
      assert.strictEqual(calls, 1)
      assert.strictEqual(input.contents, contents)
    })
  })
}).then(function () {
  console.log('Passed ' + passed + ' stream contract tests; formatter and PluginError are doubles')
}, function (error) {
  console.error(error.stack || error)
  process.exitCode = 1
})
