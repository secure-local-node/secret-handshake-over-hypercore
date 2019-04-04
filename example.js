const through = require('through2')
const pump = require('pump')
const net = require('net')
const shh = require('./')

process.stdin.pause()

const kp = shh.keygen()

const server = net.createServer((socket) => {
  const bob = shh.connect(kp.publicKey, { connect: () => socket })

  bob.on('handshake', () => {
    console.log('bob handshake')
    bob.write('hello alice!!!')
  })
})

server.listen(0, () => {
  const { port } = server.address()
  const socket = net.connect(port)
  const alice = shh.connect(kp.publicKey, { connect: () => socket })

  alice.on('handshake', () => {
    console.log('alice handshake')
    alice.name = 'alice'
    alice.write('hello bob')
    alice.on('data', console.log)
  })
})
