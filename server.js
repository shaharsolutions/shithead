const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

const PORT = process.env.PORT || 3000;
const MIN_PLAYERS = 2;
const MAX_PLAYERS = 4;

// Serve static files from public directory
app.use(express.static(path.join(__dirname, 'public')));

// Fallback to index.html for all other routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ═══════════════════════════════════════════
//  GAME ENGINE TYPES & CONSTANTS
// ═══════════════════════════════════════════
const SUITS = ['spades', 'hearts', 'diamonds', 'clubs'];
const RANKS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14];

function mkDeck() {
  const d = [];
  for (const s of SUITS) {
    for (const r of RANKS) {
      d.push({ rank: r, suit: s });
    }
  }
  return d;
}

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function sortH(h) {
  h.sort((a, b) => a.rank - b.rank);
}

// ═══════════════════════════════════════════
//  ROOM DATA STRUCTURE
// ═══════════════════════════════════════════
const rooms = new Map(); // roomId -> roomState

function generateRoomId() {
  let id = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  for (let i = 0; i < 4; i++) {
    id += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  // Make sure it's unique
  if (rooms.has(id)) return generateRoomId();
  return id;
}

// Deal a new game in a room
function dealGame(room) {
  const deck = shuffle(mkDeck());
  
  room.players.forEach(p => {
    p.hand = [];
    p.ts = [
      { fd: null, fu: null },
      { fd: null, fu: null },
      { fd: null, fu: null }
    ];
    p.ready = false;
    p.finished = false;
  });

  // Deal face downs
  for (let i = 0; i < 3; i++) {
    room.players.forEach(p => {
      p.ts[i].fd = deck.pop();
    });
  }

  // Deal face ups
  for (let i = 0; i < 3; i++) {
    room.players.forEach(p => {
      p.ts[i].fu = deck.pop();
    });
  }

  // Deal hands
  room.players.forEach(p => {
    p.hand = [deck.pop(), deck.pop(), deck.pop()];
    sortH(p.hand);
  });

  room.deck = deck;
  room.discardPile = [];
  room.burned = [];
  room.seven = false;
  room.phase = 'swap';
  room.winners = [];
}

function canPlay(room, card) {
  if (card.rank === 2 || card.rank === 3 || card.rank === 10) return true;
  if (!room.discardPile.length) return true;
  const topCard = getEffectiveTopCard(room);
  if (!topCard) return true;
  if (room.seven) return card.rank <= 7;
  return card.rank >= topCard.rank;
}

function getEffectiveTopCard(room) {
  for (let i = room.discardPile.length - 1; i >= 0; i--) {
    const card = room.discardPile[i];
    if (card.rank !== 3) return card;
  }
  return null;
}

function pSrc(player, deckLength) {
  if (player.hand.length > 0) return 'hand';
  if (deckLength > 0) return 'hand';
  if (player.ts.some(s => s.fu !== null)) return 'faceUp';
  if (player.ts.some(s => s.fd !== null)) return 'faceDown';
  return null;
}

function drawCards(room, player) {
  while (player.hand.length < 3 && room.deck.length > 0) {
    player.hand.push(room.deck.pop());
  }
  sortH(player.hand);
}

function chk4(room) {
  if (room.discardPile.length < 4) return false;
  const t = room.discardPile.slice(-4);
  return t.every(c => c.rank === t[0].rank);
}

function burnPile(room) {
  room.burned.push(...room.discardPile);
  room.discardPile = [];
  room.seven = false;
}

function isWin(player, deckLength) {
  return !player.hand.length && deckLength === 0 && player.ts.every(s => !s.fu && !s.fd);
}

// Determine who starts based on lowest card in hand (excluding 2 and 10)
function determineFirstPlayer(room) {
  const getLowestRank = (hand) => {
    const ns = hand.filter(c => c.rank !== 2 && c.rank !== 10).map(c => c.rank);
    return ns.length ? Math.min(...ns) : Infinity;
  };

  let bestIdx = 0;
  let bestRank = Infinity;

  room.players.forEach((player, idx) => {
    const lowest = getLowestRank(player.hand);
    if (lowest < bestRank) {
      bestRank = lowest;
      bestIdx = idx;
    }
  });

  return bestIdx;
}

// Sanitize state for a specific socket
function getSanitizedState(room, socketId) {
  return {
    roomId: room.id,
    phase: room.phase,
    seven: room.seven,
    discardCount: room.discardPile.length,
    deckCount: room.deck.length,
    discardTop: getEffectiveTopCard(room),
    discardHistory: room.discardPile.slice(-3), // send top 3 cards for fancy layering
    winners: room.winners || [],
    players: room.players.map(p => {
      const isSelf = p.id === socketId;
      return {
        name: p.name,
        ready: p.ready,
        finished: !!p.finished,
        isSelf: isSelf,
        isBot: !!p.isBot,
        handCount: p.hand.length,
        // Only send hand array to the player themselves
        hand: isSelf ? p.hand : [],
        // Send face-up cards to everyone, but keep face-down cards completely hidden (send only booleans)
        ts: p.ts.map(s => ({
          fu: s.fu,
          hasFD: s.fd !== null
        }))
      };
    }),
    turnIdx: room.turnIdx
  };
}

function broadcastState(room) {
  room.players.filter(p => !p.isBot).forEach(p => {
    io.to(p.id).emit('state-update', getSanitizedState(room, p.id));
  });
}

function clampPlayerCount(value) {
  const parsed = parseInt(value, 10);
  if (Number.isNaN(parsed)) return MIN_PLAYERS;
  return Math.max(MIN_PLAYERS, Math.min(MAX_PLAYERS, parsed));
}

function createPlayer(id, name, isBot = false) {
  return { id, name, isBot, ready: isBot, finished: false, hand: [], ts: [] };
}

function addBots(room, targetCount) {
  const botNames = ['מחשב 1', 'מחשב 2', 'מחשב 3'];
  while (room.players.length < targetCount) {
    const botIdx = room.players.filter(p => p.isBot).length;
    room.players.push(createPlayer(`bot:${room.id}:${botIdx + 1}`, botNames[botIdx] || `מחשב ${botIdx + 1}`, true));
  }
}

function startRoomGame(room) {
  dealGame(room);
  room.players.filter(p => p.isBot).forEach(p => { p.ready = true; });
  io.to(room.id).emit('game-start', { roomId: room.id });
  broadcastState(room);
}

function getRoomForSocket(socketId) {
  for (const room of rooms.values()) {
    const playerIdx = room.players.findIndex(p => p.id === socketId);
    if (playerIdx !== -1) return { room, player: room.players[playerIdx], playerIdx };
  }
  return { room: null, player: null, playerIdx: -1 };
}

function nextTurn(room) {
  let attempts = 0;
  do {
    room.turnIdx = (room.turnIdx + 1) % room.players.length;
    attempts++;
  } while (room.players[room.turnIdx].finished && attempts < room.players.length);
}

function scheduleBotTurn(room) {
  if (!room || room.phase !== 'play') return;
  const bot = room.players[room.turnIdx];
  if (!bot || !bot.isBot || room.botTimer) return;

  room.botTimer = setTimeout(() => {
    room.botTimer = null;
    playBotTurn(room);
  }, 900);
}

function choosePlayableGroup(cards, room) {
  const playable = cards
    .map((card, idx) => ({ card, idx }))
    .filter(({ card }) => card && canPlay(room, card))
    .sort((a, b) => a.card.rank - b.card.rank);

  if (!playable.length) return [];
  const rank = playable[0].card.rank;
  return playable.filter(({ card }) => card.rank === rank).map(({ idx }) => idx);
}

function playBotTurn(room) {
  if (!room || room.phase !== 'play') return;
  const bot = room.players[room.turnIdx];
  if (!bot || !bot.isBot) return;

  const src = pSrc(bot, room.deck.length);
  if (src === 'hand') {
    const indices = choosePlayableGroup(bot.hand, room);
    if (!indices.length) {
      if (room.discardPile.length) {
        bot.hand.push(...room.discardPile);
        room.discardPile = [];
        room.seven = false;
        sortH(bot.hand);
        io.to(room.id).emit('toast-msg', { msg: `${bot.name} לקח את הערימה`, type: 'info' });
        nextTurn(room);
        broadcastState(room);
        scheduleBotTurn(room);
      }
      return;
    }
    const cards = indices.map(idx => bot.hand[idx]);
    [...indices].sort((a, b) => b - a).forEach(idx => bot.hand.splice(idx, 1));
    executePlayState(room, bot, cards);
    return;
  }

  if (src === 'faceUp') {
    const faceUpCards = bot.ts.map(slot => slot.fu);
    const indices = choosePlayableGroup(faceUpCards, room);
    if (!indices.length) {
      if (room.discardPile.length) {
        bot.hand.push(...room.discardPile);
        room.discardPile = [];
        room.seven = false;
        sortH(bot.hand);
        io.to(room.id).emit('toast-msg', { msg: `${bot.name} לקח את הערימה`, type: 'info' });
        nextTurn(room);
        broadcastState(room);
        scheduleBotTurn(room);
      }
      return;
    }
    const cards = indices.map(idx => bot.ts[idx].fu);
    indices.forEach(idx => { bot.ts[idx].fu = null; });
    executePlayState(room, bot, cards);
    return;
  }

  if (src === 'faceDown') {
    const slotIdx = bot.ts.findIndex(slot => slot.fd);
    const card = bot.ts[slotIdx].fd;
    bot.ts[slotIdx].fd = null;
    io.to(room.id).emit('toast-msg', { msg: `${bot.name} הפך ${getCardString(card)}`, type: 'special' });
    if (canPlay(room, card)) {
      executePlayState(room, bot, [card]);
    } else {
      room.discardPile.push(card);
      broadcastState(room);
      setTimeout(() => {
        bot.hand.push(...room.discardPile);
        room.discardPile = [];
        room.seven = false;
        sortH(bot.hand);
        nextTurn(room);
        broadcastState(room);
        scheduleBotTurn(room);
      }, 1000);
    }
  }
}

// ═══════════════════════════════════════════
//  SOCKET.IO EVENT HANDLER
// ═══════════════════════════════════════════
io.on('connection', (socket) => {
  console.log(`Connected: ${socket.id}`);

  // 1. Create Room
  socket.on('create-room', ({ name, mode, playerCount }) => {
    if (!name || name.trim() === '') {
      return socket.emit('error-msg', 'נא להזין שם תקין.');
    }
    const roomId = generateRoomId();
    const maxPlayers = clampPlayerCount(playerCount);
    const room = {
      id: roomId,
      maxPlayers,
      mode: mode === 'computer' ? 'computer' : 'online',
      players: [createPlayer(socket.id, name.trim())],
      deck: [],
      discardPile: [],
      burned: [],
      seven: false,
      turnIdx: 0,
      phase: 'lobby',
      winners: []
    };
    rooms.set(roomId, room);
    socket.join(roomId);
    socket.emit('room-created', { roomId, player: room.players[0], maxPlayers, playerCount: room.players.length });
    console.log(`Room created: ${roomId} by ${name}`);

    if (room.mode === 'computer') {
      addBots(room, maxPlayers);
      startRoomGame(room);
    }
  });

  // 2. Join Room
  socket.on('join-room', ({ name, roomId }) => {
    if (!name || name.trim() === '') {
      return socket.emit('error-msg', 'נא להזין שם תקין.');
    }
    const id = roomId.trim().toUpperCase();
    if (!rooms.has(id)) {
      return socket.emit('error-msg', 'החדר לא נמצא.');
    }
    const room = rooms.get(id);
    if (room.phase !== 'lobby' || room.players.length >= room.maxPlayers) {
      return socket.emit('error-msg', 'החדר מלא או שהמשחק כבר התחיל.');
    }

    room.players.push(createPlayer(socket.id, name.trim()));
    socket.join(id);
    console.log(`${name} joined room ${id}`);

    io.to(id).emit('toast-msg', { msg: `${name.trim()} הצטרף לחדר`, type: 'info' });

    if (room.players.length === room.maxPlayers) {
      startRoomGame(room);
    }
  });

  // 3. Swap Cards (in swap phase)
  socket.on('swap-cards', ({ handIdx, slotIdx }) => {
    // Find room
    const { room: activeRoom, player } = getRoomForSocket(socket.id);

    if (!activeRoom || activeRoom.phase !== 'swap' || player.ready) return;

    if (handIdx >= 0 && handIdx < player.hand.length && slotIdx >= 0 && slotIdx < 3) {
      const temp = player.hand[handIdx];
      player.hand[handIdx] = player.ts[slotIdx].fu;
      player.ts[slotIdx].fu = temp;
      sortH(player.hand);
      broadcastState(activeRoom);
    }
  });

  // 4. Ready / Lock Hand
  socket.on('ready', () => {
    const { room: activeRoom, player } = getRoomForSocket(socket.id);

    if (!activeRoom || activeRoom.phase !== 'swap') return;

    player.ready = true;
    
    const allReady = activeRoom.players.every(p => p.ready);
    if (allReady) {
      activeRoom.phase = 'play';
      activeRoom.turnIdx = determineFirstPlayer(activeRoom);
      const activePlayer = activeRoom.players[activeRoom.turnIdx];
      io.to(activeRoom.id).emit('toast-msg', {
        msg: `${activePlayer.name} מתחיל!`,
        type: 'info'
      });
      scheduleBotTurn(activeRoom);
    } else {
      socket.to(activeRoom.id).emit('toast-msg', {
        msg: `${player.name} מוכן`,
        type: 'info'
      });
    }
    broadcastState(activeRoom);
  });

  // 5. Play Cards
  socket.on('play-cards', ({ indices }) => {
    const { room: activeRoom, playerIdx } = getRoomForSocket(socket.id);

    if (!activeRoom || activeRoom.phase !== 'play') return;
    if (activeRoom.turnIdx !== playerIdx) {
      return socket.emit('error-msg', 'זה לא התור שלך.');
    }

    const player = activeRoom.players[playerIdx];
    const src = pSrc(player, activeRoom.deck.length);

    if (src === 'hand') {
      const cards = indices.map(idx => player.hand[idx]);
      if (!cards.length || !cards.every(c => c.rank === cards[0].rank)) {
        return socket.emit('error-msg', 'בחירת הקלפים אינה תקינה.');
      }
      if (!canPlay(activeRoom, cards[0])) {
        return socket.emit('error-msg', 'אי אפשר לשחק את הקלף הזה על הערימה.');
      }

      // Valid play! Remove from hand. Sort indices descending to avoid shifting issues
      const sortedIdxs = [...indices].sort((a, b) => b - a);
      sortedIdxs.forEach(idx => player.hand.splice(idx, 1));

      // Execute play
      executePlayState(activeRoom, player, cards);
    } else if (src === 'faceUp') {
      const cards = indices.map(idx => player.ts[idx].fu);
      if (!cards.length || !cards.every(c => c.rank === cards[0].rank)) {
        return socket.emit('error-msg', 'בחירת הקלפים אינה תקינה.');
      }
      if (!canPlay(activeRoom, cards[0])) {
        return socket.emit('error-msg', 'אי אפשר לשחק את הקלף הזה על הערימה.');
      }

      // Valid play! Remove from table face up slots
      indices.forEach(idx => {
        player.ts[idx].fu = null;
      });

      executePlayState(activeRoom, player, cards);
    }
  });

  // 6. Play Face Down card blindly
  socket.on('play-facedown', ({ slotIdx }) => {
    const { room: activeRoom, playerIdx } = getRoomForSocket(socket.id);

    if (!activeRoom || activeRoom.phase !== 'play') return;
    if (activeRoom.turnIdx !== playerIdx) {
      return socket.emit('error-msg', 'זה לא התור שלך.');
    }

    const player = activeRoom.players[playerIdx];
    const src = pSrc(player, activeRoom.deck.length);
    if (src !== 'faceDown') return;

    const card = player.ts[slotIdx].fd;
    if (!card) return;

    player.ts[slotIdx].fd = null;
    
    // Broadcast flip toast
    io.to(activeRoom.id).emit('toast-msg', {
      msg: `${player.name} הפך ${getCardString(card)}`,
      type: 'special'
    });

    if (canPlay(activeRoom, card)) {
      // Play is legal!
      executePlayState(activeRoom, player, [card]);
    } else {
      // Illegal blind flip! Card goes into discard pile and player picks up entire pile.
      activeRoom.discardPile.push(card);
      broadcastState(activeRoom);
      
      io.to(activeRoom.id).emit('toast-msg', {
        msg: `קלף לא חוקי. ${player.name} לוקח את הערימה`,
        type: 'warning'
      });

      // Force pickup and end turn after a slight delay for dramatic effect
      setTimeout(() => {
        player.hand.push(...activeRoom.discardPile);
        activeRoom.discardPile = [];
        activeRoom.seven = false;
        sortH(player.hand);
        
        // Pass turn
        nextTurn(activeRoom);
        broadcastState(activeRoom);
        scheduleBotTurn(activeRoom);
      }, 1000);
    }
  });

  // 7. Pick up the pile
  socket.on('pick-up', () => {
    const { room: activeRoom, playerIdx } = getRoomForSocket(socket.id);

    if (!activeRoom || activeRoom.phase !== 'play') return;
    if (activeRoom.turnIdx !== playerIdx) {
      return socket.emit('error-msg', 'זה לא התור שלך.');
    }

    if (!activeRoom.discardPile.length) return;

    const player = activeRoom.players[playerIdx];
    
    // Can't pick up if they are forced to flip blind face-down card
    if (pSrc(player, activeRoom.deck.length) === 'faceDown') return;

    player.hand.push(...activeRoom.discardPile);
    activeRoom.discardPile = [];
    activeRoom.seven = false;
    sortH(player.hand);

    io.to(activeRoom.id).emit('toast-msg', {
      msg: `${player.name} לקח את הערימה`,
      type: 'info'
    });

    // Pass turn
    nextTurn(activeRoom);
    broadcastState(activeRoom);
    scheduleBotTurn(activeRoom);
  });

  // 8. Rematch / Reset
  socket.on('rematch', () => {
    let activeRoom = null;
    for (const room of rooms.values()) {
      if (room.players.some(p => p.id === socket.id)) {
        activeRoom = room;
        break;
      }
    }

    if (!activeRoom || activeRoom.phase !== 'over') return;

    // Reset game and deal again
    dealGame(activeRoom);
    activeRoom.players.filter(p => p.isBot).forEach(p => { p.ready = true; });
    io.to(activeRoom.id).emit('game-start', { roomId: activeRoom.id });
    broadcastState(activeRoom);
    io.to(activeRoom.id).emit('toast-msg', {
      msg: `משחק חדש התחיל`,
      type: 'info'
    });
    scheduleBotTurn(activeRoom);
  });

  // 9. Disconnect handling
  socket.on('disconnect', () => {
    console.log(`Disconnected: ${socket.id}`);
    
    for (const [roomId, room] of rooms.entries()) {
      const idx = room.players.findIndex(p => p.id === socket.id);
      if (idx !== -1) {
        // Player disconnected from a room!
        const leaver = room.players[idx];
        room.players.splice(idx, 1);
        
        if (room.players.filter(p => !p.isBot).length === 0) {
          // Room empty, delete it
          rooms.delete(roomId);
          console.log(`Deleted empty room ${roomId}`);
        } else {
          room.phase = 'lobby';
          io.to(roomId).emit('opponent-disconnected', {
            msg: `${leaver.name} התנתק. חוזרים ללובי.`
          });
          console.log(`Player left room ${roomId}. Room reset to lobby.`);
        }
        break;
      }
    }
  });
});

// Helper play logic
function executePlayState(room, player, cards) {
  cards.forEach(c => room.discardPile.push(c));
  let extraTurn = false;
  const r = cards[0].rank;

  // Broadcast played cards
  io.to(room.id).emit('toast-msg', {
    msg: `${player.name} שיחק ${cards.map(getCardString).join(', ')}`,
    type: 'info'
  });

  if (r === 10) {
    burnPile(room);
    extraTurn = true;
    io.to(room.id).emit('toast-msg', {
      msg: `${player.name} שרף את הערימה`,
      type: 'burn'
    });
  } else if (r === 7) {
    room.seven = true;
  } else if (r === 3) {
    // 3 is transparent: it can be played on anything and keeps the previous rule active.
  } else {
    room.seven = false;
  }

  // Automatic 4 of a kind burn check
  if (!extraTurn && chk4(room)) {
    burnPile(room);
    extraTurn = true;
    io.to(room.id).emit('toast-msg', {
      msg: `רביעייה. הערימה נשרפה`,
      type: 'burn'
    });
  }

  // Draw cards to maintain 3
  drawCards(room, player);

  // Check victory
  if (isWin(player, room.deck.length)) {
    player.finished = true;
    if (!room.winners) room.winners = [];
    if (!room.winners.includes(player.name)) {
      room.winners.push(player.name);
    }
    
    io.to(room.id).emit('toast-msg', {
      msg: `🎉 ${player.name} סיים את כל הקלפים שלו!`,
      type: 'special'
    });

    const activePlayers = room.players.filter(p => !p.finished);
    if (activePlayers.length <= 1) {
      // Game over! Add the last player to the ranking list
      if (activePlayers.length === 1) {
        const lastPlayer = activePlayers[0];
        lastPlayer.finished = true;
        if (!room.winners.includes(lastPlayer.name)) {
          room.winners.push(lastPlayer.name);
        }
      }
      room.phase = 'over';
      broadcastState(room);
      return;
    }
    
    // If the active player finished, they cannot take an extra turn
    extraTurn = false;
  }

  // Pass turn if not extra turn
  if (!extraTurn) {
    nextTurn(room);
  }

  broadcastState(room);
  scheduleBotTurn(room);
}

const RD = { 2:'2', 3:'3', 4:'4', 5:'5', 6:'6', 7:'7', 8:'8', 9:'9', 10:'10', 11:'J', 12:'Q', 13:'K', 14:'A' };
const SS = { spades:'♠', hearts:'♥', diamonds:'♦', clubs:'♣' };

function getCardString(c) {
  return RD[c.rank] + SS[c.suit];
}

// Start Server
server.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
