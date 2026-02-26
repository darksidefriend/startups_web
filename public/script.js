const socket = io();

let currentRoom = null;
let currentPlayer = null;
let selectedHandIndex = null; // для UI выбора карты из руки

// Экраны
const lobbyScreen = document.getElementById('lobby-screen');
const gameScreen = document.getElementById('game-screen');
const resultsScreen = document.getElementById('results-screen');

// Элементы лобби
const playerNameInput = document.getElementById('player-name');
const createBtn = document.getElementById('create-game');
const joinBtn = document.getElementById('join-game');
const roomCodeInput = document.getElementById('room-code');
const lobbyInfo = document.getElementById('lobby-info');
const displayRoomCode = document.getElementById('display-room-code');
const playersList = document.getElementById('players-list');
const startBtn = document.getElementById('start-game');

// Элементы игры
const gameRoomCodeSpan = document.getElementById('game-room-code');
const turnIndicator = document.getElementById('turn-indicator');
const opponentsDiv = document.getElementById('opponents');
const deckCount = document.getElementById('deck-count');
const marketDiv = document.getElementById('market');
const currentPlayerDiv = document.getElementById('current-player');
const handDiv = document.getElementById('hand');
const actionsDiv = document.getElementById('actions');

// Элементы результатов
const resultsList = document.getElementById('results-list');
const backToLobbyBtn = document.getElementById('back-to-lobby');

// Создание комнаты
createBtn.addEventListener('click', () => {
  const name = playerNameInput.value.trim() || 'Player';
  socket.emit('create_room', name);
});

// Присоединение
joinBtn.addEventListener('click', () => {
  const name = playerNameInput.value.trim() || 'Player';
  const code = roomCodeInput.value.trim().toUpperCase();
  if (code) {
    socket.emit('join_room', { roomCode: code, playerName: name });
  }
});

// Старт игры
startBtn.addEventListener('click', () => {
  if (currentRoom) {
    socket.emit('start_game', currentRoom);
  }
});

// Обработчики сокетов
socket.on('room_created', (data) => {
  currentRoom = data.roomCode;
  currentPlayer = data.player;
  showLobby();
});

socket.on('room_joined', (data) => {
  currentRoom = data.roomCode;
  currentPlayer = data.player;
  showLobby();
});

socket.on('players_update', (players) => {
  if (!currentRoom) return;
  renderLobbyPlayers(players);
});

socket.on('game_started', (room) => {
  currentRoom = room.id;
  showGame(room);
});

socket.on('game_update', (room) => {
  if (!room.gameEnded) {
    showGame(room);
  } else {
    showResults(room.results);
  }
});

socket.on('game_ended', (results) => {
  showResults(results);
});

socket.on('error', (msg) => {
  alert(msg);
});

// Отображение лобби
function showLobby() {
  lobbyScreen.classList.add('active');
  gameScreen.classList.remove('active');
  resultsScreen.classList.remove('active');
  lobbyInfo.style.display = 'block';
  displayRoomCode.textContent = currentRoom;
  // Запрос игроков будет обновлён через players_update
}

function renderLobbyPlayers(players) {
  playersList.innerHTML = '';
  players.forEach(p => {
    const div = document.createElement('div');
    div.className = 'player-tag';
    div.textContent = p.name;
    if (p.id === currentPlayer?.id) div.style.fontWeight = 'bold';
    playersList.appendChild(div);
  });
  // Кнопка старта только для владельца
  startBtn.style.display = (players.length >= 2 && players[0]?.id === currentPlayer?.id) ? 'block' : 'none';
}

// Отображение игры
function showGame(room) {
  lobbyScreen.classList.remove('active');
  gameScreen.classList.add('active');
  resultsScreen.classList.remove('active');
  gameRoomCodeSpan.textContent = room.id;

  // Определяем текущего игрока
  const me = room.players.find(p => p.id === currentPlayer.id);
  const isMyTurn = (room.players[room.currentPlayerIndex].id === currentPlayer.id);
  turnIndicator.textContent = isMyTurn ? 'Your turn' : `${room.players[room.currentPlayerIndex].name}'s turn`;

  // Отображаем оппонентов
  opponentsDiv.innerHTML = '';
  room.players.forEach(p => {
    if (p.id === currentPlayer.id) return;
    const oppDiv = document.createElement('div');
    oppDiv.className = 'opponent';
    oppDiv.innerHTML = `
      <div class="name">${p.name}</div>
      <div class="portfolio">${renderPortfolio(p.portfolio, room.antiChips)}</div>
      <div class="chips">💰1:${p.chips1} 🎲3:${p.chips3}</div>
    `;
    opponentsDiv.appendChild(oppDiv);
  });

  // Колода
  deckCount.textContent = room.deck.length;

  // Рынок
  marketDiv.innerHTML = '';
  room.market.forEach((card, idx) => {
    const cardDiv = document.createElement('div');
    cardDiv.className = 'market-card';
    cardDiv.dataset.index = idx;
    cardDiv.innerHTML = `
      <div>${card.company}</div>
      <div class="chips">${card.chips || 0}</div>
    `;
    cardDiv.addEventListener('click', () => {
      if (isMyTurn && room.turnPhase === 'draw') {
        socket.emit('player_action', {
          roomCode: currentRoom,
          action: 'take_from_market',
          data: { marketIndex: idx }
        });
      }
    });
    marketDiv.appendChild(cardDiv);
  });

  // Текущий игрок
  currentPlayerDiv.innerHTML = `
    <div><strong>${me.name} (you)</strong></div>
    <div class="chips-info">💰1:${me.chips1} 🎲3:${me.chips3}</div>
  `;

  // Рука
  handDiv.innerHTML = '';
  me.hand.forEach((card, idx) => {
    const cardDiv = document.createElement('div');
    cardDiv.className = `hand-card ${selectedHandIndex === idx ? 'selected' : ''}`;
    cardDiv.dataset.index = idx;
    cardDiv.textContent = card.company;
    cardDiv.addEventListener('click', () => {
      if (isMyTurn && room.turnPhase === 'play') {
        // Выбор карты для действия
        selectedHandIndex = idx;
        highlightHand();
      }
    });
    handDiv.appendChild(cardDiv);
  });

  // Кнопки действий (для фазы play)
  actionsDiv.innerHTML = '';
  if (isMyTurn && room.turnPhase === 'play') {
    const portfolioBtn = document.createElement('button');
    portfolioBtn.textContent = 'To Portfolio';
    portfolioBtn.addEventListener('click', () => {
      if (selectedHandIndex !== null) {
        socket.emit('player_action', {
          roomCode: currentRoom,
          action: 'play_to_portfolio',
          data: { handIndex: selectedHandIndex }
        });
        selectedHandIndex = null;
      } else {
        alert('Select a card from your hand first');
      }
    });
    actionsDiv.appendChild(portfolioBtn);

    const marketBtn = document.createElement('button');
    marketBtn.textContent = 'To Market';
    marketBtn.addEventListener('click', () => {
      if (selectedHandIndex !== null) {
        socket.emit('player_action', {
          roomCode: currentRoom,
          action: 'play_to_market',
          data: { handIndex: selectedHandIndex }
        });
        selectedHandIndex = null;
      } else {
        alert('Select a card from your hand first');
      }
    });
    actionsDiv.appendChild(marketBtn);
  } else if (isMyTurn && room.turnPhase === 'draw') {
    const deckBtn = document.createElement('button');
    deckBtn.textContent = 'Take from Deck';
    deckBtn.addEventListener('click', () => {
      socket.emit('player_action', {
        roomCode: currentRoom,
        action: 'take_from_deck',
        data: {}
      });
    });
    actionsDiv.appendChild(deckBtn);
    // Взять с рынка осуществляется кликом по карте рынка
  }
}

function highlightHand() {
  document.querySelectorAll('.hand-card').forEach(card => {
    card.classList.remove('selected');
  });
  if (selectedHandIndex !== null) {
    const selected = document.querySelector(`.hand-card[data-index="${selectedHandIndex}"]`);
    if (selected) selected.classList.add('selected');
  }
}

function renderPortfolio(portfolio, antiChips) {
  let html = '';
  for (const [company, count] of Object.entries(portfolio)) {
    const chip = antiChips[company];
    html += `<span class="company-badge" style="background: ${getCompanyColor(company)};">${company} ${count}${chip ? ' 👑' : ''}</span>`;
  }
  return html;
}

function getCompanyColor(company) {
  const colors = {
    'Giraffe Beer': 'orange',
    'Bowwow Gaming': 'blue',
    'Flamingo Soft': 'pink',
    'Octo Coffee': 'brown',
    'Hippo Electronics': 'green',
    'Elephant Moon Transfer': 'red'
  };
  return colors[company] || 'gray';
}

// Результаты
function showResults(results) {
  lobbyScreen.classList.remove('active');
  gameScreen.classList.remove('active');
  resultsScreen.classList.add('active');
  resultsList.innerHTML = '';
  results.forEach((r, i) => {
    const div = document.createElement('div');
    div.textContent = `${i+1}. ${r.name} – ${r.score} points (💰1:${r.chips1}, 🎲3:${r.chips3})`;
    resultsList.appendChild(div);
  });
}

backToLobbyBtn.addEventListener('click', () => {
  // Сброс состояния
  currentRoom = null;
  currentPlayer = null;
  selectedHandIndex = null;
  lobbyScreen.classList.add('active');
  resultsScreen.classList.remove('active');
  gameScreen.classList.remove('active');
  lobbyInfo.style.display = 'none';
  playerNameInput.value = 'Player';
  roomCodeInput.value = '';
});