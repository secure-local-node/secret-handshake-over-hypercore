const Server = require('simple-websocket/server')
const crypto = require('ara-crypto')
const pump = require('pump')
const net = require('net')
const shh = require('./')

const sharedKey = Buffer.from('12abf5a9165201b0d5f284d7d902f57b19ca0a6f974bcd8fcc3162c93b2b75f1', 'hex')

const server = new Server({ port: 3000 })

server.setMaxListeners(0)
server.on('connection', (socket) => {
  global.bob = shh.connect(sharedKey, {
    connect: () => socket,
    capabilities: [
      shh.capability('auth'),
      shh.capability('read'),
    ]
  })

  bob.on('error', console.error)
  bob.on('handshake', () => {
    console.log('bob handshake')
    bob.write('hello alice!!!')

    bob.on('data', (buf) => console.log(buf.toString()))
  })
})
