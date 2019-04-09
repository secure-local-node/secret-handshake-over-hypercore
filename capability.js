const crypto = require('ara-crypto')

function capability(name, key, shouldNormalize = true) {
  if ('boolean' === typeof key) {
    shouldNormalize = key
    key = null
  }

  const buffer = Buffer.from(shouldNormalize ? normalize(name) : name)
  return crypto.blake2b(buffer, 32, key)
}

function normalize(name) {
  if ('string' === typeof name) {
    return name.trim().replace(/[\s|\n|\t|\r]+/g, '')
  } else {
    return name
  }
}

module.exports = {
  capability,
  normalize,
}
