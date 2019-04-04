const Server = require('simple-websocket/server')
const crypto = require('ara-crypto')
const pump = require('pump')
const net = require('net')
const shh = require('./')

const sharedKey = Buffer.from('12abf5a9165201b0d5f284d7d902f57b19ca0a6f974bcd8fcc3162c93b2b75f1', 'hex')

const server = new Server({ port: 3000 })

server.on('connection', (socket) => {
  global.bob = shh.connect(sharedKey, {
    connect: () => socket,
    capabilities: [
      Buffer.from('09398de3daad336ec736af462388297d8abd7fe621168c35a4ec2a53b327c816', 'hex'),
      Buffer.from('4a0d23babe9e616a66e21fe8a2377f6c8c1b885bb941211eb3a75505032057f6', 'hex'),
    ]
  })

  bob.on('error', console.error)
  bob.on('handshake', () => {
    console.log('bob handshake')
    bob.write('hello alice!!!')

    bob.on('readable', () => {
      console.log('%s', bob.read().toString())
    })
  })
})
