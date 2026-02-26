const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

// Хранилище комнат
const rooms = {};

// Компании
const COMPANIES = [
  { name: 'Giraffe Beer', color: 'orange', count: 5 },
  { name: 'Bowwow Gaming', color: 'blue', count: 6 },
  { name: 'Flamingo Soft', color: 'pink', count: 7 },
  { name: 'Octo Coffee', color: 'brown', count: 8 },
  { name: 'Hippo Electronics', color: 'green', count: 9 },
  { name: 'Elephant Moon Transfer', color: 'red', count: 10 }
];

// Генерация кода комнаты
function generateRoomCode() {
  return Math.random().toString(36).substring(2, 6).toUpperCase();
}

// Создание колоды
function createDeck() {
  let deck = [];
  COMPANIES.forEach(company => {
    for (let i = 0; i < company.count; i++) {
      deck.push({ company: company.name });
    }
  });
  // Удаляем 5 случайных карт
  for (let i = 0; i < 5; i++) {
    const index = Math.floor(Math.random() * deck.length);
    deck.splice(index, 1);
  }
  return shuffle(deck);
}

// Перемешивание
function shuffle(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

// Инициализация комнаты
function initRoom(roomId, ownerId) {
  rooms[roomId] = {
    id: roomId,
    owner: ownerId,
    players: [],
    gameStarted: false,
    deck: [],
    market: [],
    removedCards: [],
    antiChips: {}, // company -> playerId
    currentPlayerIndex: 0,
    turnPhase: 'draw', // 'draw' or 'play'
    lastCardTaker: null, // id игрока, взявшего последнюю карту
    gameEnded: false
  };
}

// Добавление игрока в комнату
function addPlayer(roomId, socketId, playerName) {
  const room = rooms[roomId];
  if (!room) return null;
  const player = {
    id: socketId,
    name: playerName,
    hand: [],
    portfolio: {}, // company -> count
    chips1: 10,
    chips3: 0,
    isActive: true
  };
  room.players.push(player);
  return player;
}

// Удаление игрока
function removePlayer(roomId, socketId) {
  const room = rooms[roomId];
  if (!room) return;
  const index = room.players.findIndex(p => p.id === socketId);
  if (index !== -1) {
    room.players.splice(index, 1);
    // Если игрок был владельцем, передать владение
    if (room.owner === socketId && room.players.length > 0) {
      room.owner = room.players[0].id;
    }
    // Если игра началась и осталось < 2 игроков, завершить
    if (room.gameStarted && room.players.length < 2) {
      endGame(roomId, 'Not enough players');
    }
  }
}

// Пересчёт антимонопольных чипов
function recalcAntiChips(room) {
  const newChips = {};
  // Инициализируем все компании
  COMPANIES.forEach(c => newChips[c.name] = null);

  // Для каждой компании ищем лидера
  COMPANIES.forEach(company => {
    const counts = room.players.map(p => ({
      playerId: p.id,
      count: p.portfolio[company.name] || 0
    }));
    const maxCount = Math.max(...counts.map(c => c.count));
    if (maxCount === 0) return; // никто не имеет карт этой компании

    const leaders = counts.filter(c => c.count === maxCount).map(c => c.playerId);
    if (leaders.length === 1) {
      // Единоличный лидер
      newChips[company.name] = leaders[0];
    } else {
      // Ничья: чип остаётся у предыдущего владельца, если он среди лидеров, иначе у первого лидера
      const prevOwner = room.antiChips[company.name];
      if (prevOwner && leaders.includes(prevOwner)) {
        newChips[company.name] = prevOwner;
      } else {
        // назначаем первого лидера (по порядку игроков)
        newChips[company.name] = leaders[0];
      }
    }
  });
  room.antiChips = newChips;
}

// Начало игры
function startGame(roomId) {
  const room = rooms[roomId];
  if (!room || room.gameStarted) return;

  // Создаём колоду
  room.deck = createDeck();

  // Раздаём по 3 карты каждому игроку
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

  room.market = [];
  room.antiChips = {};
  COMPANIES.forEach(c => room.antiChips[c.name] = null);
  room.currentPlayerIndex = Math.floor(Math.random() * room.players.length);
  room.turnPhase = 'draw';
  room.gameStarted = true;
  room.gameEnded = false;
  room.lastCardTaker = null;
}

// Проверка возможности взять из колоды
function canTakeFromDeck(room, player) {
  // Считаем количество карт на рынке, за которые нужно платить
  let payableCards = room.market.filter(card => {
    // Если у игрока есть антимонопольный чип этой компании – не платит
    return room.antiChips[card.company] !== player.id;
  }).length;
  return player.chips1 >= payableCards;
}

// Взять карту из колоды
function takeFromDeck(room, player) {
  if (!canTakeFromDeck(room, player)) return false;

  // Положить фишки на карты рынка
  room.market.forEach(card => {
    if (room.antiChips[card.company] !== player.id) {
      card.chips = (card.chips || 0) + 1;
    }
  });
  player.chips1 -= room.market.filter(c => room.antiChips[c.company] !== player.id).length;

  // Взять верхнюю карту колоды
  const card = room.deck.pop();
  if (!card) return false; // колода пуста – не должно происходить
  player.hand.push(card);

  // Проверяем, была ли это последняя карта
  if (room.deck.length === 0) {
    room.lastCardTaker = player.id;
  }

  room.turnPhase = 'play';
  return true;
}

// Взять карту с рынка
function takeFromMarket(room, player, marketIndex) {
  const card = room.market[marketIndex];
  if (!card) return false;
  // Проверка антимонопольного чипа
  if (room.antiChips[card.company] === player.id) return false;

  // Удаляем карту с рынка
  room.market.splice(marketIndex, 1);
  // Добавляем в руку
  player.hand.push({ company: card.company });
  // Забираем фишки
  player.chips1 += card.chips || 0;
  // Запоминаем, что взял эту компанию (для запрета сброса)
  player.lastTakenCompany = card.company;
  room.turnPhase = 'play';
  return true;
}

// Положить карту в портфель
function playToPortfolio(room, player, handIndex) {
  const card = player.hand[handIndex];
  if (!card) return false;

  // Удаляем из руки
  player.hand.splice(handIndex, 1);
  // Добавляем в портфель
  const company = card.company;
  player.portfolio[company] = (player.portfolio[company] || 0) + 1;

  // Пересчёт антимонопольных чипов
  recalcAntiChips(room);

  // Сброс флага lastTakenCompany
  delete player.lastTakenCompany;

  // Переход к следующему игроку
  nextTurn(room);
  return true;
}

// Положить карту на рынок
function playToMarket(room, player, handIndex) {
  const card = player.hand[handIndex];
  if (!card) return false;

  // Проверка запрета на сброс той же компании, что взял с рынка
  if (player.lastTakenCompany === card.company) return false;

  // Удаляем из руки
  player.hand.splice(handIndex, 1);
  // Добавляем на рынок
  room.market.push({ company: card.company, chips: 0 });

  // Сброс флага lastTakenCompany
  delete player.lastTakenCompany;

  // Переход к следующему игроку
  nextTurn(room);
  return true;
}

// Следующий ход
function nextTurn(room) {
  // Проверяем, не закончилась ли игра (последняя карта взята и текущий игрок завершил ход)
  if (room.lastCardTaker !== null && room.players[room.currentPlayerIndex].id === room.lastCardTaker) {
    // Игрок, взявший последнюю карту, только что завершил ход – заканчиваем игру
    finishGame(room);
    return;
  }

  // Переходим к следующему игроку
  room.currentPlayerIndex = (room.currentPlayerIndex + 1) % room.players.length;
  room.turnPhase = 'draw';
  // У всех игроков сбрасываем lastTakenCompany (на всякий случай)
  room.players.forEach(p => delete p.lastTakenCompany);
}

// Завершение игры и подсчёт
function finishGame(room) {
  // 1. Все игроки добавляют карты из руки в портфель
  room.players.forEach(player => {
    player.hand.forEach(card => {
      const company = card.company;
      player.portfolio[company] = (player.portfolio[company] || 0) + 1;
    });
    player.hand = [];
  });

  // 2. Подсчёт мажоритарных акционеров и передача фишек 3
  // Сначала вычисляем net-изменения для каждого игрока
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
    if (leaders.length !== 1) return; // ничья – ничего не делаем

    const majorityId = leaders[0];
    // Каждый другой игрок с картами должен отдать по 1 фишке 3 за каждую свою карту
    counts.forEach(c => {
      if (c.playerId !== majorityId && c.count > 0) {
        net3[majorityId] += c.count; // мажоритарный получает по 1 фишке 3 за каждую карту
        net3[c.playerId] -= c.count; // должник теряет (может уйти в минус)
      }
    });
  });

  // Применяем изменения
  room.players.forEach(player => {
    player.chips3 += net3[player.id];
    // Не позволяем фишкам 3 стать отрицательными? Оставляем как есть (долг)
  });

  // 3. Вычисляем очки: chips1 + chips3*3
  const results = room.players.map(player => ({
    name: player.name,
    score: player.chips1 + player.chips3 * 3,
    chips1: player.chips1,
    chips3: player.chips3
  }));

  // Сортируем по убыванию очков, затем по chips3, затем lastCardTaker
  results.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    if (a.chips3 !== b.chips3) return b.chips3 - a.chips3;
    // Если последний ход за игроком, он побеждает при ничье
    if (a.id === room.lastCardTaker) return -1;
    if (b.id === room.lastCardTaker) return 1;
    return 0;
  });

  room.gameEnded = true;
  room.results = results;
}

// Socket.IO
io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  // Создать комнату
  socket.on('create_room', (playerName) => {
    const roomCode = generateRoomCode();
    initRoom(roomCode, socket.id);
    const player = addPlayer(roomCode, socket.id, playerName);
    socket.join(roomCode);
    socket.emit('room_created', { roomCode, player });
    io.to(roomCode).emit('players_update', rooms[roomCode].players);
  });

  // Присоединиться к комнате
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
    io.to(roomCode).emit('players_update', room.players);
  });

  // Начать игру
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
    io.to(roomCode).emit('game_started', room);
  });

  // Действие игрока
  socket.on('player_action', ({ roomCode, action, data }) => {
    const room = rooms[roomCode];
    if (!room || !room.gameStarted || room.gameEnded) return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player) return;
    // Проверка, что сейчас ход этого игрока
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
      io.to(roomCode).emit('game_update', room);
    } else {
      socket.emit('error', 'Invalid action');
    }
  });

  // Отключение
  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
    for (const roomCode in rooms) {
      const room = rooms[roomCode];
      const player = room?.players.find(p => p.id === socket.id);
      if (player) {
        removePlayer(roomCode, socket.id);
        io.to(roomCode).emit('players_update', room.players);
        if (room.gameStarted && !room.gameEnded) {
          // Если игра идёт, завершаем
          finishGame(room);
          io.to(roomCode).emit('game_update', room);
          io.to(roomCode).emit('game_ended', room.results);
        }
        if (room.players.length === 0) {
          delete rooms[roomCode];
        }
        break;
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});