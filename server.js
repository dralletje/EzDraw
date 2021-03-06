import { map } from 'lodash'
import fs from 'fs'
import socketIO from 'socket.io'

// Local server to test: run "npm run server"
let io = socketIO(3040)

let rooms = []
// Users is only used to check for existing usernames
let users = []
let lobby = 'Lobby'
let words = fs.readFileSync('./words.txt', 'utf8').split('\n')

// Game logic

// Getting a random word for a Game
let getRandomWord = () => {
  let randomWord = words[ Math.floor(Math.random() * words.length) ]
  return randomWord
}

// Rank the users
let rankUsers = xs =>
  xs.slice()
  .sort((a,b) => b.score - a.score)

// Creating a new game
let createNewGame = (players, artist) => {
  let Game = {
    time: 90,
    players,
    lettersGiven: [],
    word: getRandomWord(),
    artist: artist,
  }
  return Game
}

io.on('listening', () => {
  console.log('Server accepting connections')
})

io.on('connection', socket => {
  //Autojoin lobby, a general purpose room for creating & joining a room
  socket.join(lobby)

  // Choose username
  socket.on('approveUsername', newUsername => {
    let index = users.map(user => user.username).findIndex(username => username === newUsername)

    // If no user exists with this username, approve it
    if (index === -1) {
      //Emit them their approved username and the current rooms
      socket.emit('usernameApproved', newUsername)
      updateUsers()
      let newUser = {
        username: newUsername,
      }
      socket.user = newUser
      users = [...users, newUser]
    }
    // If there is a user with that username, disapprove it
    else {
      socket.emit('usernameDisapproved')
    }
  })

  // Update the users in the lobby
  let updateUsers = () => {
    io.sockets.in(lobby).emit('rooms', rooms)
    rooms.forEach(room => {
      let sortedUsers = rankUsers(room.users)
      room.users = sortedUsers
      io.sockets.in(room.roomName).emit('users', room.users)
    })
  }

  // Joining a room
  let joinRoom = newRoomName => {
    let newRoomIndex = rooms.map(room => room.roomName).findIndex(roomName => roomName === newRoomName)
    let newRoom = rooms[newRoomIndex]
    socket.join(newRoom.roomName)
    socket.roomName = newRoom.roomName
    let roomUser = {
      ...socket.user,
      score: 0,
      guessed: false,
    }
    newRoom.users = [...newRoom.users, roomUser]
    updateUsers()
  }

  // Getting a random letter as a hint
  let giveRandomLetter = (roomName, game) => {
    //We store the indexes of the given letters in an array, and here we filter out the indexes
    //of the letters we have already given
    let wordIndexes = map(game.word, (letter, index) => index)
    let unguessedIndexes = wordIndexes.filter(letterIndex => {
      let indexInGuessed = game.lettersGiven.findIndex(givenLetterIndex => letterIndex === givenLetterIndex)
      //If its not in lettersGiven, keep it, otherwise discard it
      return indexInGuessed === -1 ? true : false
    })
    let randomLetterIndex = unguessedIndexes[Math.floor(Math.random() * unguessedIndexes.length)]
    return randomLetterIndex
  }

  // Create a room
  socket.on('approveRoomName', newRoomName => {
    let index = rooms.map(room => room.roomName).findIndex(roomName => roomName === newRoomName)
    if (index === -1) {
      socket.emit('roomNameApproved', newRoomName)

      // Create the new room
      let newRoom = {
        roomName: newRoomName,
        users: [],
        currentGame: null,
        nextUp: [],
        startGame() {
          // Here we start a Game
          // First we do a countdown of 3 seconds
          io.sockets.in(this.roomName).emit('countdown')
          io.sockets.in(this.roomName).emit('clearCanvas')

          // Update users to get rid of the stars / artists
          this.users = this.users.map(user => {
            return {
              ...user,
              guessed: false,
            }
          })
          updateUsers()

          // Create a new game
          if (this.nextUp.length === 0) {
            this.nextUp = rankUsers(this.users)
          }
          let [currentUser, ...nextUp] = this.nextUp
          this.currentGame = createNewGame(this.users, currentUser)
          this.nextUp = nextUp

          //Do this after the countdown has finished
          setTimeout(() => {
            //How many letters you're gonna get
            let amountOfLetters = Math.floor(this.currentGame.word.length / 3)
            let atInterval = Math.floor(90 / (amountOfLetters + 1))

            // Start the timer
            let timer = setInterval(() => {
              if (this.currentGame) {
                io.sockets.in(this.roomName).emit('time', this.currentGame.time)
                this.currentGame.time = this.currentGame.time - 1
                if (this.currentGame.time % atInterval === 0 && this.currentGame.time !== 0 && this.currentGame.time !== 90) {
                  let randomLetterIndex = giveRandomLetter(this.roomName, this.currentGame)
                  this.currentGame.lettersGiven = [...this.currentGame.lettersGiven, randomLetterIndex]
                  let freeLetter = {
                    letter: this.currentGame.word[randomLetterIndex],
                    index: randomLetterIndex,
                  }
                  io.sockets.in(this.roomName).emit('freeLetter', freeLetter)
                }
                if (this.currentGame.time < 0) {
                  this.endGame()
                }
              }
              else {
                clearInterval(timer)
              }
            }, 1000)

            // Emit the artist and word
            io.sockets.in(this.roomName).emit('startGame', {
              artist: this.currentGame.artist,
              word: this.currentGame.word,
            })
          }, 3000)
        },
        endGame() {
          this.currentGame = null
          io.sockets.in(this.roomName).emit('endGame')
          setTimeout(() => {
            if (this.users.length > 1) {
              this.startGame()
            }
          }, 10000)
        },
      }
      rooms = [...rooms, newRoom]

      // Join it
      joinRoom(newRoomName)
    }
    else {
      socket.emit('roomNameDisapproved')
    }
  })

  // On client request to join, not creation
  socket.on('joinRoom', newRoomName => {
    let roomIndex = rooms.map(room => room.roomName).findIndex(roomName => roomName === newRoomName)
    if (roomIndex !== -1) {
      joinRoom(newRoomName)
    }
    let room = rooms[roomIndex]
    setTimeout(() => {
      if (room.users.length > 1) {
        room.startGame()
      }
    }, 3000)
  })

  // Leaving a room
  let leaveRoom = () => {
    let currentRoomIndex = rooms.map(room => room.roomName).findIndex(roomName => roomName === socket.roomName)
    let currentRoom = rooms[currentRoomIndex]
    let ourIndex = currentRoom.users.map(user => user.username).findIndex(username => username === socket.user.username)
    currentRoom.users.splice(ourIndex, 1)
    // If we are the last one in the room
    if (currentRoom.users.length === 0) {
      rooms.splice(currentRoomIndex, 1)
    }
    // If we are leaving an active game and the remaining users.length < 2
    if (currentRoom.currentGame && currentRoom.users.length < 2) {
      currentRoom.endGame()
    }
    socket.leave(socket.roomName)
  }

  // Process messages
  socket.on('message', message => {
    let currentRoomIndex = rooms.map(room => room.roomName).findIndex(roomName => roomName === socket.roomName)
    let currentRoom = rooms[currentRoomIndex]

    // If our message matches the current word
    if (currentRoom.currentGame) {
      if (message.body.toLowerCase() === currentRoom.currentGame.word.toLowerCase()) {
        // And we're NOT the artist AND we haven't guessed the word yet
        let ourIndex = currentRoom.users.map(user => user.username).findIndex(username => username === socket.user.username)
        let ourUser = currentRoom.users[ourIndex]
        if (currentRoom.currentGame.artist.username !== socket.user.username && !ourUser.guessed) {
          // Calculate score
          ourUser.score = ourUser.score + currentRoom.currentGame.time
          // Set guessed to true
          ourUser.guessed = true
          // Let the user know they guessed it (show the word && gives star && plays sound)
          updateUsers()
          socket.emit('guessed', currentRoom.currentGame.word)
          // If everyone guessed it (except the artist), end the game
          let guessers = currentRoom.users.filter(user => user.guessed ? true : false)
          if (guessers.length === currentRoom.users.length - 1) {
            currentRoom.endGame()
          }
        }
        // If we are the artist, don't do anything (we don't allow spoiling the word)
      }
      else {
        io.sockets.in(socket.roomName).emit('message', {
          body: message.body,
          user: message.user,
        })
      }
    }
    else {
      io.sockets.in(socket.roomName).emit('message', {
        body: message.body,
        user: message.user,
      })
    }
  })

  // On draw
  socket.on('draw', drawArgs => {
    let currentRoomIndex = rooms.map(room => room.roomName).findIndex(roomName => roomName === socket.roomName)
    let currentRoom = rooms[currentRoomIndex]
    if (currentRoom.currentGame) {
      // Send drawArgs to everyone but me (no double-drawing)
      socket.broadcast.to(currentRoom.roomName).emit('draw', drawArgs)
    }
  })

  // On disconnect
  socket.on('disconnect', data => {
    let ourIndex = users.map(user => user.username).findIndex(username => username === socket.user.username)
    users.splice(ourIndex, 1)
    if (socket.roomName) {
      leaveRoom()
      updateUsers()
    }
  })
})

console.log('Listening on :3040')
