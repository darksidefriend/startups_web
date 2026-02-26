const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

const rooms = {};

const COMPANIES = [
  { name: 'Giraffe Beer', color: 'orange', count: 5 },
  { name: 'Bowwow Gaming', color: 'blue', count: 6 },
  { name: 'Flamingo Soft', color: 'pink', count: 7 },
  { name: 'Octo Coffee', color: 'brown', count: 8 },
  { name: 'Hippo Electronics', color: 'green', count: 9 },
  { name: 'Elephant Moon Transfer', color: 'red', count: 10 }
];

function generateRoomCode() {
  return Math.random().toString(36).substring(2, 6).toUpperCase();
}

// --- Вспомогательные функции для работы с комнатами ---
function broadcastRoomList() {
  const list = Object.values(rooms).map(room => ({
    id: room.id,
    players: room.players.length,
    maxPlayers: 7, // или можно хранить в комнате
    gameStarted: room.gameStarted
  }));
  io.emit('rooms_list', list);
}

function addSystemMessage(room, text) {
  if (!room.messages) room.messages = [];
  const msg = { sender: 'System', text, system: true, timestamp: Date.now() };
  room.messages.push(msg);
  // Ограничим историю 50 сообщениями
  if (room.messages.length > 50) room.messages.shift();
  io.to(room.id).emit('chat_message', msg);
}

function createDeck() {
  let deck = [];
  COMPANIES.forEach(company => {
    for (let i = 0; i < company.count; i++) {
      deck.push({ company: company.name });
    }
  });
  for (let i = 0; i < 5; i++) {
    const index = Math.floor(Math.random() * deck.length);
    deck.splice(index, 1);
  }
  return shuffle(deck);
}

function shuffle(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

function initRoom(roomId, ownerId) {
  rooms[roomId] = {
    id: roomId,
    owner: ownerId,
    players: [],
    gameStarted: false,
    deck: [],
    market: [],
    antiChips: {},
    currentPlayerIndex: 0,
    turnPhase: 'draw',
    lastCardTaken: false,
    lastCardTakenPlayer: null,
    gameEnded: false,
    messages: [] // для чата
  };
}

function addPlayer(roomId, socketId, playerName) {
  const room = rooms[roomId];
  if (!room) return null;
  const player = {
    id: socketId,
    name: playerName,
    hand: [],
    portfolio: {},
    chips1: 10,
    chips3: 0,
    isActive: true
  };
  room.players.push(player);
  addSystemMessage(room, `${playerName} joined the room.`);
  return player;
}

function removePlayer(roomId, socketId) {
  const room = rooms[roomId];
  if (!room) return;
  const player = room.players.find(p => p.id === socketId);
  if (player) {
    addSystemMessage(room, `${player.name} left the room.`);
  }
  const index = room.players.findIndex(p => p.id === socketId);
  if (index !== -1) {
    room.players.splice(index, 1);
    if (room.owner === socketId && room.players.length > 0) {
      room.owner = room.players[0].id;
    }
    if (room.gameStarted && room.players.length < 2) {
      endGame(room);
    }
  }
}


function recalcAntiChips(room) {
  const newChips = {};
  COMPANIES.forEach(c => newChips[c.name] = null);

  COMPANIES.forEach(company => {
    const counts = room.players.map(p => ({
      playerId: p.id,
      count: p.portfolio[company.name] || 0
    }));
    const maxCount = Math.max(...counts.map(c => c.count));
    if (maxCount === 0) return;

    const leaders = counts.filter(c => c.count === maxCount).map(c => c.playerId);
    if (leaders.length === 1) {
      newChips[company.name] = leaders[0];
    } else {
      const prevOwner = room.antiChips[company.name];
      if (prevOwner && leaders.includes(prevOwner)) {
        newChips[company.name] = prevOwner;
      } else {
        newChips[company.name] = leaders[0];
      }
    }
  });
  room.antiChips = newChips;
}

function computeCompanyTotals(room) {
  const totals = {};
  COMPANIES.forEach(c => totals[c.name] = 0);
  room.players.forEach(p => {
    Object.entries(p.portfolio).forEach(([company, count]) => {
      totals[company] += count;
    });
  });
  room.players.forEach(p => {
    p.hand.forEach(card => {
      totals[card.company] += 1;
    });
  });
  room.market.forEach(card => {
    totals[card.company] += 1;
  });
  return totals;
}

function startGame(roomId) {
  const room = rooms[roomId];
  if (!room || room.gameStarted) return;

  room.deck = createDeck();
  room.players.forEach(player => {
    player.hand = [];
    for (let i = 0; i < 3; i++) {
      if (room.deck.length > 0) {
        player.hand.push(room.deck.pop());
      }
    }
    player.portfolio = {};
    player.chips1 = 10;
    player.chips3 = 0;
  });
  addSystemMessage(room, 'Game started!');
  room.market = [];
  room.antiChips = {};
  COMPANIES.forEach(c => room.antiChips[c.name] = null);
  room.currentPlayerIndex = Math.floor(Math.random() * room.players.length);
  room.turnPhase = 'draw';
  room.gameStarted = true;
  room.gameEnded = false;
  room.lastCardTaken = false;
  room.lastCardTakenPlayer = null;
}

function canTakeFromDeck(room, player) {
  let payableCards = room.market.filter(card => {
    return room.antiChips[card.company] !== player.id;
  }).length;
  return player.chips1 >= payableCards;
}

function takeFromDeck(room, player) {
  if (!canTakeFromDeck(room, player)) return false;

  room.market.forEach(card => {
    if (room.antiChips[card.company] !== player.id) {
      card.chips = (card.chips || 0) + 1;
    }
  });
  player.chips1 -= room.market.filter(c => room.antiChips[c.company] !== player.id).length;

  const card = room.deck.pop();
  if (!card) return false;
  player.hand.push(card);

  if (room.deck.length === 0) {
    room.lastCardTaken = true;
    room.lastCardTakenPlayer = player.id;
  }

  room.turnPhase = 'play';
  return true;
}

function takeFromMarket(room, player, marketIndex) {
  const card = room.market[marketIndex];
  if (!card) return false;
  if (room.antiChips[card.company] === player.id) return false;

  room.market.splice(marketIndex, 1);
  player.hand.push({ company: card.company });
  player.chips1 += card.chips || 0;
  player.lastTakenCompany = card.company;
  room.turnPhase = 'play';
  return true;
}

function playToPortfolio(room, player, handIndex) {
  const card = player.hand[handIndex];
  if (!card) return false;

  player.hand.splice(handIndex, 1);
  const company = card.company;
  player.portfolio[company] = (player.portfolio[company] || 0) + 1;

  recalcAntiChips(room);
  delete player.lastTakenCompany;

  if (room.lastCardTaken && player.id === room.lastCardTakenPlayer) {
    endGame(room);
  } else {
    nextTurn(room);
  }
  return true;
}

function playToMarket(room, player, handIndex) {
  if (room.lastCardTaken && player.id === room.lastCardTakenPlayer) {
    return false;
  }

  const card = player.hand[handIndex];
  if (!card) return false;
  if (player.lastTakenCompany === card.company) return false;

  player.hand.splice(handIndex, 1);
  room.market.push({ company: card.company, chips: 0 });

  delete player.lastTakenCompany;
  nextTurn(room);
  return true;
}

function nextTurn(room) {
  room.currentPlayerIndex = (room.currentPlayerIndex + 1) % room.players.length;
  room.turnPhase = 'draw';
  room.players.forEach(p => delete p.lastTakenCompany);
}

function endGame(room) {
  room.players.forEach(player => {
    player.hand.forEach(card => {
      const company = card.company;
      player.portfolio[company] = (player.portfolio[company] || 0) + 1;
    });
    player.hand = [];
  });

  recalcAntiChips(room);

  const net3 = {};
  room.players.forEach(p => net3[p.id] = 0);

  COMPANIES.forEach(company => {
    const counts = room.players.map(p => ({
      playerId: p.id,
      count: p.portfolio[company.name] || 0
    }));
    const maxCount = Math.max(...counts.map(c => c.count));
    if (maxCount === 0) return;
    const leaders = counts.filter(c => c.count === maxCount).map(c => c.playerId);
    if (leaders.length !== 1) return;

    const majorityId = leaders[0];
    counts.forEach(c => {
      if (c.playerId !== majorityId && c.count > 0) {
        net3[majorityId] += c.count;
        net3[c.playerId] -= c.count;
      }
    });
  });

  room.players.forEach(player => {
    player.chips3 += net3[player.id];
  });

  const results = room.players.map(player => ({
    name: player.name,
    id: player.id,
    score: player.chips1 + player.chips3 * 3,
    chips1: player.chips1,
    chips3: player.chips3
  }));

  results.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    if (a.chips3 !== b.chips3) return b.chips3 - a.chips3;
    if (a.id === room.lastCardTakenPlayer) return -1;
    if (b.id === room.lastCardTakenPlayer) return 1;
    return 0;
  });

  room.gameEnded = true;
  room.results = results;
}

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  // При подключении отправляем список комнат
  broadcastRoomList();

  socket.on('create_room', (playerName) => {
    const roomCode = generateRoomCode();
    initRoom(roomCode, socket.id);
    const player = addPlayer(roomCode, socket.id, playerName);
    socket.join(roomCode);
    socket.emit('room_created', { roomCode, player });
    io.to(roomCode).emit('players_update', rooms[roomCode].players);
    broadcastRoomList(); // обновить список для всех
  });

  socket.on('join_room', ({ roomCode, playerName }) => {
    roomCode = roomCode.toUpperCase();
    const room = rooms[roomCode];
    if (!room) {
      socket.emit('error', 'Room not found');
      return;
    }
    if (room.gameStarted) {
      socket.emit('error', 'Game already started');
      return;
    }
    if (room.players.length >= 7) {
      socket.emit('error', 'Room is full');
      return;
    }
    const player = addPlayer(roomCode, socket.id, playerName);
    socket.join(roomCode);
    socket.emit('room_joined', { roomCode, player });
    // Отправляем историю чата новому игроку
    socket.emit('chat_history', room.messages || []);
    io.to(roomCode).emit('players_update', room.players);
    broadcastRoomList(); // обновить список
  });

  socket.on('start_game', (roomCode) => {
    const room = rooms[roomCode];
    if (!room) return;
    if (room.owner !== socket.id) {
      socket.emit('error', 'Only owner can start');
      return;
    }
    if (room.players.length < 2) {
      socket.emit('error', 'Need at least 2 players');
      return;
    }
    startGame(roomCode);
    room.companyTotals = computeCompanyTotals(room);
    io.to(roomCode).emit('game_started', room);
    broadcastRoomList(); // комната теперь в игре
  });

  socket.on('player_action', ({ roomCode, action, data }) => {
    const room = rooms[roomCode];
    if (!room || !room.gameStarted || room.gameEnded) return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player) return;
    if (room.players[room.currentPlayerIndex].id !== socket.id) {
      socket.emit('error', 'Not your turn');
      return;
    }

    let success = false;
    if (action === 'take_from_deck') {
      if (room.turnPhase !== 'draw') return;
      success = takeFromDeck(room, player);
    } else if (action === 'take_from_market') {
      if (room.turnPhase !== 'draw') return;
      success = takeFromMarket(room, player, data.marketIndex);
    } else if (action === 'play_to_portfolio') {
      if (room.turnPhase !== 'play') return;
      success = playToPortfolio(room, player, data.handIndex);
    } else if (action === 'play_to_market') {
      if (room.turnPhase !== 'play') return;
      success = playToMarket(room, player, data.handIndex);
    }

    if (success) {
      room.companyTotals = computeCompanyTotals(room);
      io.to(roomCode).emit('game_update', room);
      if (room.gameEnded) {
        io.to(roomCode).emit('game_ended', room.results);
        broadcastRoomList(); // комната завершена, исчезнет из списка (можно фильтровать)
      }
    } else {
      socket.emit('error', 'Invalid action');
    }
  });

  socket.on('send_message', ({ roomCode, text }) => {
    const room = rooms[roomCode];
    if (!room) return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player) return;
    const msg = {
      sender: player.name,
      text: text,
      system: false,
      timestamp: Date.now()
    };
    if (!room.messages) room.messages = [];
    room.messages.push(msg);
    if (room.messages.length > 50) room.messages.shift();
    io.to(roomCode).emit('chat_message', msg);
  });

  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
    for (const roomCode in rooms) {
      const room = rooms[roomCode];
      const player = room?.players.find(p => p.id === socket.id);
      if (player) {
        removePlayer(roomCode, socket.id);
        io.to(roomCode).emit('players_update', room.players);
        if (room.gameStarted && !room.gameEnded) {
          endGame(room);
          io.to(roomCode).emit('game_update', room);
          io.to(roomCode).emit('game_ended', room.results);
        }
        if (room.players.length === 0) {
          delete rooms[roomCode];
        }
        broadcastRoomList(); // обновить список
        break;
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});