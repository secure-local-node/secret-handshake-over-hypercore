const Server = require('simple-websocket/server')
const pump = require('pump')
const net = require('net')
const shh = require('./')

const sharedKey = Buffer.from('12abf5a9165201b0d5f284d7d902f57b19ca0a6f974bcd8fcc3162c93b2b75f1', 'hex')

const server = new Server({ port: 3000 })

server.on('connection', (socket) => {
  global.bob = shh.connect(sharedKey, { connect: () => socket })

  bob.on('handshake', () => {
    console.log('bob handshake')
    bob.write('hello alice!!!')

    bob.on('readable', () => {
      console.log('%s', bob.read().toString())
    })
  })
})
