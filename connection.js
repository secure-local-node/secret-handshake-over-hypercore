const { Duplex } = require('readable-stream')
const { keygen } = require('./keygen')
const increment = require('increment-buffer')
const hypercore = require('hypercore')
const crypto = require('ara-crypto')
const Batch = require('batch')
const debug = require('debug')('secret-handshake-over-hypercore:connection')
const pump = require('pump')
const ram = require('random-access-memory')

const $hasHandshake = Symbol('hasHandshake')
const $receiver = Symbol('receiver')
const $reading = Symbol('reading')
const $counter = Symbol('counter')
const $sender = Symbol('sender')
const $stream = Symbol('stream')

class Connection extends Duplex {
  constructor(opts) {
    super()
    this.setMaxListeners(0)

    if ('function' !== typeof opts.connect) {
      throw new TypeError('Connection expects a opts.connect(...) factory')
    }

    if (opts.storage && 'function' !== typeof opts.storage) {
      throw new TypeError('Connection expects a opts.storage(...) factory')
    }

    if (Buffer.isBuffer(opts.publicKey) && Buffer.isBuffer(opts.secretKey)) {
      this.publicKey = opts.publicKey
      this.secretKey = opts.secretKey
    } else {
      const { publicKey, secretKey } = keygen()
      this.publicKey = publicKey
      this.secretKey = secretKey
    }

    this.createConnection = opts.connect
    this.createStorage = opts.storage || (() => ram)

    this.remoteSessionPublicKey = null
    this.remotePublicKey = null

    const sessionKeyPair = keygen()
    this.sessionPublicKey = sessionKeyPair.publicKey
    this.sessionSecretKey = sessionKeyPair.secretKey

    this.sharedKey = opts.sharedKey

    if (Array.isArray(opts.capabilities)) {
      this.capabilities = opts.capabilities
    } else {
      this.capabilities = []
    }

    for (let i = 0; i < this.capabilities.length; ++i) {
      if (!this.capabilities[i]) {
        delete this.capabilities[i]
      }

      if ('string' === typeof this.capabilities[i]) {
        this.capabilities[i] = Buffer.from(this.capabilities[i])
      }

      if (false === Buffer.isBuffer(this.capabilities[i])) {
        this.capabilities[i] = Buffer.from(this.capabilities[i])
      }
    }

    this.remoteNonce = null
    this.nonce = null

    this.capabilities = this.capabilities
      .filter(Buffer.isBuffer)
      .sort(Buffer.compare)

    this[$hasHandshake] = false
    this[$receiver] = null
    this[$reading] = false
    this[$counter] = 0
    this[$stream] = null

    this.feed = this.createHypercore('feed', this.sharedKey, {
      storageCacheSize: 0,
      sparse: true
    })

    this[$sender] = this.createHypercore('sender', this.publicKey, {
      storageCacheSize: 0,
      storeSecretKey: false,
      secretKey: this.secretKey,
      sparse: true,
    })

    if (true === opts.seal && 'function' === typeof Object.seal) {
      Object.seal(this)
    }

    this.feed.ready(() => {
      this.emit('feed', this.feed)
    })

    this.once('close', () => {
      if (this.feed) {
        this.feed.close()
      }

      if (this[$sender]) {
        this[$sender].close()
      }

      if (this[$receiver]) {
        this[$receiver].close()
      }

      this[$hasHandshake] = false
      this[$receiver] = null
      this[$reading] = false
      this[$counter] = 0
      this[$sender] = null
      this[$stream] = null

      this.feed = null
    })
  }

  get hasHandshake() {
    return this[$hasHandshake]
  }

  get reading() {
    return this[$reading]
  }

  get receiver() {
    return this[$receiver]
  }

  get sender() {
    return this[$sender]
  }

  get counter() {
    return this[$counter]
  }

  _read(size) {
    void size
  }

  _write(chunk, enc, done) {
    if (this.encryptionKey) {
      const key = this.encryptionKey
      const nonce = increment(this.nonce)
      const boxed = crypto.box(chunk, { key, nonce })
      const signature = crypto.ed25519.sign(boxed, this.secretKey)
      this.sender.append(Buffer.concat([ signature, boxed ]), done)
    } else {
      this.sender.append(chunk, done)
    }
  }

  createHypercore(name, publicKey, opts) {
    return hypercore(this.createStorage(name), publicKey, opts)
  }

  replicate(opts) {
    return this.sender.replicate(opts)
  }

  doWrite(buffer) {
    process.nextTick(() => {
      if (this.writable && !this.destroyed) {
        this.write(buffer)
      }
    })
  }

  connect(cb) {
    const { publicKey } = this
    const stream = this.feed.replicate({
      userData: publicKey,
      download: false,
      upload: false,
      live: true,
    })

    const wire = this.createConnection(this)
    const pipe = wire ? pump(wire, stream, wire) : stream

    this.pause()
    this.cork()

    if (wire) {
      this.emit('connection', wire, { publicKey })
    }

    stream.on('handshake', () => {
      const remotePublicKey = stream.remoteUserData

      if (Buffer.isBuffer(this.remotePublicKey)) {
        return
      }

      if (0 === Buffer.compare(this.publicKey, remotePublicKey)) {
        return
      }

      this.remotePublicKey = remotePublicKey

      this.emit('hypercore-handshake', {
        remotePublicKey,
        publicKey,
      })

      this[$stream] = stream
      this[$receiver] = this.createHypercore('receiver', remotePublicKey, {
        storageCacheSize: 0,
        sparse: true
      })

      this.sender.replicate({
        download: false,
        upload: true,
        live: true,
        stream,
      })

      this.receiver.ready(() => {
        this.emit('receiver', this.receiver)

        this.receiver.replicate({
          download: true,
          upload: false,
          live: true,
          stream,
        })
      })

      this.uncork()
      this.resume()
      this.startReading()
      this.handshake(cb)
    })

    return pipe
  }

  stopReading() {
    this[$reading] = false
  }

  startReading() {
    const kick = () => {
      if (!this.readable || this.destroyed) {
        this.stopReading()
      }

      if (this[$reading]) {
        const { receiver } = this
        debug('clear %d-%d', 0, this[$counter], receiver.length)
        receiver.get(this[$counter]++, { wait: true }, (err, buf) => {
          if (err) {
            onread(err)
          } else {
            receiver.clear(this[$counter], (err) => onread(err, buf))
          }
        })
      }
    }

    const onread = (err, buf) => {
      if (err) {
        this.emit('error', err)
      } else if (buf && this[$reading]) {
        if (this.encryptionKey && this.remoteNonce) {
          const key = this.encryptionKey
          const nonce = increment(this.remoteNonce)
          const boxed = buf.slice(64)
          const unboxed = crypto.unbox(boxed, { key, nonce })
          const signature = buf.slice(0, 64)
          if (crypto.ed25519.verify(signature, boxed, this.remotePublicKey)) {
            this.push(unboxed)
          } else {
            err = new Error('Incoming message failed verification')
            this.emit('error', err)
          }
        } else {
          this.push(buf)
        }
      }

      kick()
    }

    if (true !== this[$reading]) {
      this[$reading] = true
      kick()
      return true
    }

    return false
  }

  handshake(cb) {
    this.hello()
    this.once('data', (buf) => {
      const mac = buf.slice(0, 32)
      const remoteSessionPublicKey = buf.slice(32)

      const key = crypto.curve25519.shared(
        this.sharedKey,
        crypto.curve25519.shared(this.publicKey, remoteSessionPublicKey)
      )

      let verified = crypto.auth.verify(mac, this.remotePublicKey, key)

      if (true !== verified) {
        const err = new Error('Handshake failed verification in hello')
        if ('function' === typeof cb) { cb(err) }
        else { this.emit('error', err) }
        return
      }

      this.remoteSessionPublicKey = remoteSessionPublicKey
      this.remoteNonce = crypto.blake2b(mac, 24)

      this.emit('hello', {
        sessionKey: this.remoteSessionPublicKey,
        publicKey: this.remotePublicKey,
        verified,
        mac,
      })

      this.auth()
      this.once('data', (buf) => {
        const capabilities = Buffer.concat(this.capabilities)
        const nonce = this.remoteNonce
        const key = Buffer.concat([
          this.sharedKey,
          crypto.curve25519.shared(
            this.remoteSessionPublicKey,
            this.sessionPublicKey
          ),
          crypto.curve25519.shared(
            this.remoteSessionPublicKey,
            this.publicKey
          ),
        ])

        const unboxed = crypto.unbox(buf, { key, nonce })
        const remotePublicKey = unboxed.slice(0, 32)

        if (0 !== Buffer.compare(this.remotePublicKey, remotePublicKey)) {
          const err = new Error('Handshake remote public key does not match in auth')
          if ('function' === typeof cb) { cb(err) }
          else { this.emit('error', err) }
          return
        }

        const proof = Buffer.concat([
          this.sharedKey,
          this.publicKey,
          crypto.blake2b(crypto.curve25519.shared(
            this.remoteSessionPublicKey,
            this.sessionPublicKey
          )),
        ])

        const signature = unboxed.slice(32, 32 + 64)
        const remoteCapabilities = unboxed.slice(32 + signature.length)

        verified = crypto.ed25519.verify(signature, proof, remotePublicKey)

        if (true !== verified) {
          const err = new Error('Handshake failed verification in hello')
          if ('function' === typeof cb) { cb(err) }
          else { this.emit('error', err) }
          return
        }

        const ours = new Set([ ...this.capabilities ])
        const theirs = new Set()
        const intersection = []

        for (let i = 0; i < remoteCapabilities.length; i += 32) {
          const capability = remoteCapabilities.slice(i, i + 32)
          theirs.add(capability)
          for (const c of [ ...ours ]) {
            if (0 === Buffer.compare(c, capability)) {
              intersection.push(capability)
            }
          }
        }

        if (0 === intersection.length && ours.size) {
          const err = new Error('Handshake failed capability check in auth')
          if ('function' === typeof cb) { cb(err) }
          else { this.emit('error', err) }
          return
        }

        this.intersectionCapabilities = intersection.sort(Buffer.compare)

        this.emit('auth', {
          capability: [ ...theirs ],
          publicKey: this.remotePublicKey,
          signature,
          verified,
        })

        this.okay(unboxed)
        this.once('data', (buf) => {
          const key = Buffer.concat([
            this.sharedKey,
            crypto.curve25519.shared(
              this.sessionPublicKey,
              this.remoteSessionPublicKey,
            ),
            crypto.curve25519.shared(
              this.sessionPublicKey,
              this.remotePublicKey,
            ),
            crypto.curve25519.shared(
              this.publicKey,
              this.remoteSessionPublicKey,
            )
          ])

          const proof = Buffer.concat([
            this.sharedKey,
            crypto.blake2b(crypto.curve25519.shared(
              this.sessionPublicKey,
              this.remoteSessionPublicKey
            ))
          ])

          const sig = crypto.unbox(buf, {
            nonce: this.remoteNonce,
            key,
          })

          verified = crypto.ed25519.verify(sig, proof, this.remotePublicKey)

          if (true !== verified) {
            const err = new Error('Handshake failed verification in okay')
            if ('function' === typeof cb) { cb(err) }
            else { this.emit('error', err) }
            return
          }

          this.cork()
          this.pause()
          this.stopReading()

          this.encryptionKey = Buffer.concat([
            key,
            Buffer.concat(this.intersectionCapabilities)
          ])

          const pending = new Batch()
          const stream = this[$stream]

          pending.concurrency(1)
          pending.push((next) => this.receiver.close(() => next()))
          pending.push((next) => this.sender.close(() => next()))

          pending.push((next) => {
            this[$sender] = this.createHypercore(
              'sender',
              this.sessionPublicKey, {
                storageCacheSize: 0,
                storeSecretKey: false,
                secretKey: this.sessionSecretKey,
                sparse: true,
              })

            this.sender.ready(() => {
              this.emit('sender', this.sender)
              next()
            })

            this.sender.replicate({
              download: false,
              upload: true,
              live: true,
              stream,
            })
          })

          pending.push((next) => {
            this.receiver.ready(() => {
              this.emit('receiver', this.receiver)
              next()
            })

            this[$receiver] = this.createHypercore(
              'receiver',
              this.remoteSessionPublicKey, {
              storageCacheSize: 0,
              sparse: true
            })

            this.receiver.replicate({
              download: true,
              upload: false,
              live: true,
              stream,
            })
          })

          pending.end(() => {
            this[$hasHandshake] = true
            this[$counter] = 0

            this.emit('handshake', this[$stream])
            this.resume()
            this.uncork()
            this.startReading()
          })
        })
      })
    })
  }

  hello() {
    const {
      remotePublicKey,
      sessionPublicKey,
      publicKey,
      sharedKey,
    } = this

    const key = crypto.curve25519.shared(
      sharedKey,
      crypto.curve25519.shared(remotePublicKey, sessionPublicKey)
    )

    const mac = crypto.auth(publicKey, key)
    const buffer = Buffer.concat([ mac, sessionPublicKey ])

    this.nonce = crypto.blake2b(mac, 24)
    this.doWrite(buffer)
  }

  auth() {
    const {
      remotePublicKey,
      publicKey,
      secretKey,
      sharedKey,
      nonce,
    } = this

    const capabilities = Buffer.concat(this.capabilities)
    const proof = Buffer.concat([
      sharedKey,
      remotePublicKey,
      crypto.blake2b(crypto.curve25519.shared(
        this.sessionPublicKey,
        this.remoteSessionPublicKey,
      )),
    ])

    const signature = crypto.ed25519.sign(proof, secretKey)
    const auth = Buffer.concat([ publicKey, signature, capabilities ])
    const key = Buffer.concat([
      sharedKey,
      crypto.curve25519.shared(
        this.sessionPublicKey,
        this.remoteSessionPublicKey
      ),
      crypto.curve25519.shared(
        this.sessionPublicKey,
        this.remotePublicKey
      ),
    ])

    const box = crypto.box(auth, { nonce, key })

    this.doWrite(box)
  }

  okay(auth) {
    const remotePublicKey = auth.slice(0, 32)
    const signature = auth.slice(32)
    const { nonce } = this

    const key = Buffer.concat([
      this.sharedKey,
      crypto.curve25519.shared(
        this.remoteSessionPublicKey,
        this.sessionPublicKey,
      ),
      crypto.curve25519.shared(
        this.remoteSessionPublicKey,
        this.publicKey,
      ),
      crypto.curve25519.shared(
        this.remotePublicKey,
        this.sessionPublicKey,
      )
    ])

    const proof = Buffer.concat([
      this.sharedKey,
      crypto.blake2b(crypto.curve25519.shared(
        this.remoteSessionPublicKey,
        this.sessionPublicKey
      ))
    ])

    const sig = crypto.ed25519.sign(proof, this.secretKey)
    const box = crypto.box(sig, { key, nonce })

    this.doWrite(box)
  }
}

module.exports = {
  Connection,
}
