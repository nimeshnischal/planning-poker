(function () {
  'use strict';

  const DECK_CARDS = [
    { value: '0', label: '0', numeric: 0 },
    { value: '1', label: '1', numeric: 1 },
    { value: '2', label: '2', numeric: 2 },
    { value: '3', label: '3', numeric: 3 },
    { value: '5', label: '5', numeric: 5 },
    { value: '8', label: '8', numeric: 8 },
    { value: '13', label: '13', numeric: 13 },
    { value: '21', label: '21', numeric: 21 },
    { value: '?', label: '?', numeric: null },
    { value: 'Coffee', label: 'Coffee', numeric: null }
  ];

  const PEER_PREFIX = 'pp-v1-room-';
  const STORAGE_NAME_KEY = 'pp_player_name';
  const STORAGE_SESSION_KEY = 'pp_active_session';
  const STORAGE_HOST_STATE_PREFIX = 'pp_host_state_';
  const HEARTBEAT_INTERVAL_MS = 3000;
  const HEARTBEAT_TIMEOUT_MS = 8500;
  const RECONNECT_DELAY_MS = 3000;

  const PEER_CONFIG = {
    config: {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' }
      ]
    }
  };

  // Application State
  const app = {
    mode: 'create', // 'create' | 'join'
    isHost: false,
    roomCode: '',
    playerId: '',
    playerName: '',
    isSpectator: false,
    myVote: null,
    peer: null,
    hostConn: null,
    hostConnOpen: false,
    lastHostPongAt: 0,
    clientConns: new Map(), // playerId -> DataConnection (host only)
    reconnectTimer: null,
    heartbeatTimer: null,
    // Authoritative room state (maintained by host, mirrored on clients)
    roomState: {
      roomCode: '',
      round: 1,
      story: '',
      revealed: false,
      participants: []
    },
    // Host-only secret votes map: playerId -> vote string | null
    hostVotes: new Map()
  };

  function logDebug(scope, message, details) {
    const role = app.isHost ? 'Host' : 'Client';
    const prefix = '[PlanningPoker][' + role + '][' + scope + ']';
    if (details !== undefined) {
      console.log(prefix, message, details);
    } else {
      console.log(prefix, message);
    }
  }

  function logWarn(scope, message, details) {
    const role = app.isHost ? 'Host' : 'Client';
    const prefix = '[PlanningPoker][' + role + '][' + scope + ']';
    if (details !== undefined) {
      console.warn(prefix, message, details);
    } else {
      console.warn(prefix, message);
    }
  }

  function logError(scope, message, details) {
    const role = app.isHost ? 'Host' : 'Client';
    const prefix = '[PlanningPoker][' + role + '][' + scope + ']';
    if (details !== undefined) {
      console.error(prefix, message, details);
    } else {
      console.error(prefix, message);
    }
  }

  // DOM Elements
  const els = {
    sessionHeaderControls: document.getElementById('sessionHeaderControls'),
    statusDot: document.getElementById('statusDot'),
    statusText: document.getElementById('statusText'),
    roomCodeDisplay: document.getElementById('roomCodeDisplay'),
    copyInviteBtn: document.getElementById('copyInviteBtn'),
    toggleSpectatorBtn: document.getElementById('toggleSpectatorBtn'),
    leaveRoomBtn: document.getElementById('leaveRoomBtn'),

    lobbyView: document.getElementById('lobbyView'),
    lobbyForm: document.getElementById('lobbyForm'),
    playerNameInput: document.getElementById('playerNameInput'),
    spectatorCheckbox: document.getElementById('spectatorCheckbox'),
    tabCreateBtn: document.getElementById('tabCreateBtn'),
    tabJoinBtn: document.getElementById('tabJoinBtn'),
    joinRoomGroup: document.getElementById('joinRoomGroup'),
    roomCodeInput: document.getElementById('roomCodeInput'),
    lobbyError: document.getElementById('lobbyError'),
    lobbySubmitBtn: document.getElementById('lobbySubmitBtn'),

    sessionView: document.getElementById('sessionView'),
    storyTitleInput: document.getElementById('storyTitleInput'),
    roundNumberDisplay: document.getElementById('roundNumberDisplay'),
    tableStatusMessage: document.getElementById('tableStatusMessage'),
    revealBtn: document.getElementById('revealBtn'),
    resetBtn: document.getElementById('resetBtn'),
    participantsGrid: document.getElementById('participantsGrid'),

    resultsPanel: document.getElementById('resultsPanel'),
    statAverage: document.getElementById('statAverage'),
    statMedian: document.getElementById('statMedian'),
    statAgreement: document.getElementById('statAgreement'),
    statDistribution: document.getElementById('statDistribution'),

    deckSection: document.getElementById('deckSection'),
    deckPromptText: document.getElementById('deckPromptText'),
    cardDeck: document.getElementById('cardDeck'),
    toastContainer: document.getElementById('toastContainer')
  };

  function generateRoomCode() {
    const chars = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
    let code = '';
    const randomValues = new Uint32Array(6);
    window.crypto.getRandomValues(randomValues);
    for (let i = 0; i < 6; i++) {
      code += chars[randomValues[i] % chars.length];
    }
    return code;
  }

  function generatePlayerId() {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let id = 'p_';
    const randomValues = new Uint32Array(10);
    window.crypto.getRandomValues(randomValues);
    for (let i = 0; i < 10; i++) {
      id += chars[randomValues[i] % chars.length];
    }
    return id;
  }

  function normalizeRoomCode(raw) {
    return String(raw || '')
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '')
      .slice(0, 8);
  }

  function showToast(message) {
    logDebug('UI', 'Toast notification:', message);
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = message;
    els.toastContainer.appendChild(toast);
    setTimeout(() => {
      toast.remove();
    }, 3200);
  }

  function setLobbyError(message) {
    if (!message) {
      els.lobbyError.textContent = '';
      els.lobbyError.classList.add('hidden');
      return;
    }
    logWarn('Lobby', 'Lobby error displayed:', message);
    els.lobbyError.textContent = message;
    els.lobbyError.classList.remove('hidden');
  }

  function setConnectionStatus(state, label) {
    logDebug('ConnectionStatus', 'State changed to "' + state + '" (' + label + ')');
    els.statusDot.className = 'status-dot';
    if (state === 'connecting') {
      els.statusDot.classList.add('connecting');
    } else if (state === 'disconnected') {
      els.statusDot.classList.add('disconnected');
    }
    els.statusText.textContent = label;
  }

  function setLobbyMode(mode) {
    app.mode = mode;
    setLobbyError('');
    if (mode === 'create') {
      els.tabCreateBtn.classList.add('active');
      els.tabCreateBtn.setAttribute('aria-selected', 'true');
      els.tabJoinBtn.classList.remove('active');
      els.tabJoinBtn.setAttribute('aria-selected', 'false');
      els.joinRoomGroup.classList.add('hidden');
      els.lobbySubmitBtn.textContent = 'Create Room';
    } else {
      els.tabJoinBtn.classList.add('active');
      els.tabJoinBtn.setAttribute('aria-selected', 'true');
      els.tabCreateBtn.classList.remove('active');
      els.tabCreateBtn.setAttribute('aria-selected', 'false');
      els.joinRoomGroup.classList.remove('hidden');
      els.lobbySubmitBtn.textContent = 'Join Room';
    }
  }

  function renderDeck() {
    els.cardDeck.innerHTML = '';
    DECK_CARDS.forEach((card) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'deck-card' + (card.label.length > 2 ? ' card-word' : '');
      btn.dataset.value = card.value;
      btn.textContent = card.label;
      btn.addEventListener('click', () => {
        handleCardClick(card.value);
      });
      els.cardDeck.appendChild(btn);
    });
  }

  function updateDeckUI() {
    const buttons = els.cardDeck.querySelectorAll('.deck-card');
    const disableVoting = app.isSpectator || app.roomState.revealed;

    if (app.isSpectator) {
      els.deckPromptText.textContent = 'You are in spectator mode. Switch to voter mode in the top bar to estimate.';
    } else if (app.roomState.revealed) {
      els.deckPromptText.textContent = 'Votes are revealed. Start a new round to vote again.';
    } else if (app.myVote !== null) {
      els.deckPromptText.textContent = 'Your estimate is locked in (' + app.myVote + '). Click another card to change or click again to clear.';
    } else {
      els.deckPromptText.textContent = 'Select a card to cast your estimate';
    }

    buttons.forEach((btn) => {
      const val = btn.dataset.value;
      btn.disabled = disableVoting;
      if (!app.isSpectator && app.myVote === val) {
        btn.classList.add('selected');
      } else {
        btn.classList.remove('selected');
      }
    });
  }

  function renderParticipants() {
    els.participantsGrid.innerHTML = '';
    const participants = app.roomState.participants || [];
    const revealed = app.roomState.revealed;

    participants.forEach((p) => {
      const seat = document.createElement('div');
      seat.className = 'participant-seat' + (p.id === app.playerId ? ' is-self' : '');

      const card = document.createElement('div');
      card.className = 'participant-card';

      if (p.isSpectator) {
        card.classList.add('spectator');
        card.textContent = 'Spectator';
      } else if (revealed) {
        if (p.vote !== null && p.vote !== undefined) {
          card.classList.add('revealed');
          card.textContent = p.vote;
        } else {
          card.classList.add('empty');
          card.textContent = '-';
        }
      } else if (p.hasVoted) {
        card.classList.add('voted-hidden');
        card.textContent = p.id === app.playerId && app.myVote !== null ? app.myVote : '✓';
      } else {
        card.classList.add('empty');
        card.textContent = '...';
      }

      const info = document.createElement('div');
      info.className = 'participant-info';

      const nameEl = document.createElement('div');
      nameEl.className = 'participant-name';
      nameEl.textContent = p.name + (p.id === app.playerId ? ' (You)' : '');

      const roleEl = document.createElement('div');
      roleEl.className = 'participant-role';
      const tags = [];
      if (p.isHost) tags.push('Host');
      if (p.isSpectator) tags.push('Spectator');
      else tags.push(p.hasVoted ? 'Ready' : 'Thinking');
      roleEl.textContent = tags.join(' • ');

      info.appendChild(nameEl);
      info.appendChild(roleEl);
      seat.appendChild(card);
      seat.appendChild(info);
      els.participantsGrid.appendChild(seat);
    });
  }

  function renderTableAndStats() {
    const participants = app.roomState.participants || [];
    const voters = participants.filter((p) => !p.isSpectator);
    const votedCount = voters.filter((p) => p.hasVoted).length;
    const revealed = app.roomState.revealed;

    els.roundNumberDisplay.textContent = String(app.roomState.round || 1);

    if (document.activeElement !== els.storyTitleInput) {
      els.storyTitleInput.value = app.roomState.story || '';
    }

    els.toggleSpectatorBtn.textContent = app.isSpectator ? 'Mode: Spectator' : 'Mode: Voter';

    if (revealed) {
      els.tableStatusMessage.textContent = 'Cards revealed for Round ' + app.roomState.round;
      els.revealBtn.disabled = true;
      els.resultsPanel.classList.remove('hidden');
      computeAndRenderStats(voters);
    } else {
      els.resultsPanel.classList.add('hidden');
      els.revealBtn.disabled = votedCount === 0;
      if (voters.length === 0) {
        els.tableStatusMessage.textContent = 'Waiting for voters to join';
      } else if (votedCount === 0) {
        els.tableStatusMessage.textContent = 'Waiting for team members to pick a card (0/' + voters.length + ' ready)';
      } else if (votedCount < voters.length) {
        els.tableStatusMessage.textContent = votedCount + ' of ' + voters.length + ' players ready';
      } else {
        els.tableStatusMessage.textContent = 'All ' + voters.length + ' players have voted! Ready to reveal.';
      }
    }
  }

  function computeAndRenderStats(voters) {
    const numericVotes = [];
    const counts = new Map();

    voters.forEach((p) => {
      if (p.vote === null || p.vote === undefined) return;
      counts.set(p.vote, (counts.get(p.vote) || 0) + 1);
      const cardMeta = DECK_CARDS.find((c) => c.value === p.vote);
      if (cardMeta && typeof cardMeta.numeric === 'number') {
        numericVotes.push(cardMeta.numeric);
      }
    });

    if (numericVotes.length > 0) {
      const sum = numericVotes.reduce((acc, v) => acc + v, 0);
      const avg = sum / numericVotes.length;
      els.statAverage.textContent = Number.isInteger(avg) ? String(avg) : avg.toFixed(1);

      const sorted = numericVotes.slice().sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      const median =
        sorted.length % 2 !== 0
          ? sorted[mid]
          : (sorted[mid - 1] + sorted[mid]) / 2;
      els.statMedian.textContent = Number.isInteger(median) ? String(median) : median.toFixed(1);
    } else {
      els.statAverage.textContent = '-';
      els.statMedian.textContent = '-';
    }

    const totalCast = Array.from(counts.values()).reduce((a, b) => a + b, 0);
    if (totalCast > 0) {
      const highestCount = Math.max(...Array.from(counts.values()));
      const agreementPct = Math.round((highestCount / totalCast) * 100);
      els.statAgreement.textContent = agreementPct === 100 && totalCast > 1 ? '100% Consensus' : agreementPct + '%';
    } else {
      els.statAgreement.textContent = '-';
    }

    els.statDistribution.innerHTML = '';
    if (counts.size === 0) {
      const emptySpan = document.createElement('span');
      emptySpan.className = 'field-hint';
      emptySpan.textContent = 'No votes cast';
      els.statDistribution.appendChild(emptySpan);
      return;
    }

    counts.forEach((count, cardVal) => {
      const chip = document.createElement('span');
      chip.className = 'dist-chip';
      const strong = document.createElement('strong');
      strong.textContent = cardVal;
      const text = document.createTextNode(' × ' + count);
      chip.appendChild(strong);
      chip.appendChild(text);
      els.statDistribution.appendChild(chip);
    });
  }

  function renderSessionUI() {
    renderParticipants();
    renderTableAndStats();
    updateDeckUI();
  }

  function saveSessionToStorage() {
    try {
      localStorage.setItem(STORAGE_NAME_KEY, app.playerName);
      const sessionData = {
        roomCode: app.roomCode,
        playerId: app.playerId,
        playerName: app.playerName,
        isSpectator: app.isSpectator,
        isHost: app.isHost,
        myVote: app.myVote
      };
      sessionStorage.setItem(STORAGE_SESSION_KEY, JSON.stringify(sessionData));
      localStorage.setItem(STORAGE_SESSION_KEY + '_' + app.roomCode, JSON.stringify(sessionData));
    } catch (_) {
      // Ignore storage errors in private browsing modes
    }
  }

  function saveHostRoomStateToStorage() {
    if (!app.isHost || !app.roomCode) return;
    try {
      const votesObj = {};
      app.hostVotes.forEach((val, key) => {
        votesObj[key] = val;
      });
      const snapshot = {
        round: app.roomState.round,
        story: app.roomState.story,
        revealed: app.roomState.revealed,
        votes: votesObj,
        savedAt: Date.now()
      };
      localStorage.setItem(STORAGE_HOST_STATE_PREFIX + app.roomCode, JSON.stringify(snapshot));
    } catch (_) {}
  }

  function loadHostRoomStateFromStorage(roomCode) {
    try {
      const raw = localStorage.getItem(STORAGE_HOST_STATE_PREFIX + roomCode);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (_) {
      return null;
    }
  }

  function clearSessionStorage() {
    try {
      sessionStorage.removeItem(STORAGE_SESSION_KEY);
      if (app.roomCode) {
        localStorage.removeItem(STORAGE_SESSION_KEY + '_' + app.roomCode);
        localStorage.removeItem(STORAGE_HOST_STATE_PREFIX + app.roomCode);
      }
    } catch (_) {
      // Ignore storage errors
    }
  }

  function updateUrlRoomParam(roomCode) {
    const url = new URL(window.location.href);
    if (roomCode) {
      url.searchParams.set('room', roomCode);
    } else {
      url.searchParams.delete('room');
    }
    window.history.replaceState({}, '', url.toString());
  }

  function enterSessionView() {
    els.lobbyView.classList.add('hidden');
    els.sessionView.classList.remove('hidden');
    els.sessionHeaderControls.classList.remove('hidden');
    els.roomCodeDisplay.textContent = app.roomCode;
    updateUrlRoomParam(app.roomCode);
    saveSessionToStorage();
    renderSessionUI();
  }

  function cleanupPeer() {
    logDebug('Cleanup', 'Cleaning up PeerJS connections and timers');
    if (app.reconnectTimer) {
      clearTimeout(app.reconnectTimer);
      app.reconnectTimer = null;
    }
    if (app.heartbeatTimer) {
      clearInterval(app.heartbeatTimer);
      app.heartbeatTimer = null;
    }
    app.hostConnOpen = false;
    if (app.hostConn) {
      try {
        app.hostConn.close();
      } catch (_) {}
      app.hostConn = null;
    }
    app.clientConns.forEach((conn) => {
      try {
        conn.close();
      } catch (_) {}
    });
    app.clientConns.clear();
    if (app.peer) {
      try {
        app.peer.destroy();
      } catch (_) {}
      app.peer = null;
    }
  }

  // Host Logic
  function buildHostBroadcastState(targetPlayerId) {
    const revealed = app.roomState.revealed;
    const participants = app.roomState.participants.map((p) => {
      const rawVote = app.hostVotes.get(p.id) ?? null;
      return {
        id: p.id,
        name: p.name,
        isSpectator: Boolean(p.isSpectator),
        isHost: Boolean(p.isHost),
        hasVoted: !p.isSpectator && rawVote !== null,
        vote: revealed ? rawVote : null
      };
    });

    return {
      type: 'STATE_SYNC',
      state: {
        roomCode: app.roomState.roomCode,
        round: app.roomState.round,
        story: app.roomState.story,
        revealed: app.roomState.revealed,
        participants
      },
      yourVote: targetPlayerId ? (app.hostVotes.get(targetPlayerId) ?? null) : null
    };
  }

  function hostSyncAll() {
    if (!app.isHost) return;
    const selfPayload = buildHostBroadcastState(app.playerId);
    app.roomState = selfPayload.state;
    app.myVote = selfPayload.yourVote;
    saveHostRoomStateToStorage();
    saveSessionToStorage();
    renderSessionUI();

    logDebug('Sync', 'Broadcasting room state to ' + app.clientConns.size + ' client(s)', {
      round: app.roomState.round,
      revealed: app.roomState.revealed,
      participants: app.roomState.participants.map((p) => ({
        id: p.id,
        name: p.name,
        hasVoted: p.hasVoted
      }))
    });

    app.clientConns.forEach((conn, playerId) => {
      if (conn && conn.open) {
        conn.send(buildHostBroadcastState(playerId));
      } else {
        logWarn('Sync', 'Skipping closed connection for playerId=' + playerId);
      }
    });
  }

  function hostUpsertParticipant(player) {
    const list = app.roomState.participants;
    const idx = list.findIndex((p) => p.id === player.id);
    if (idx >= 0) {
      list[idx] = {
        ...list[idx],
        name: player.name,
        isSpectator: Boolean(player.isSpectator),
        isHost: Boolean(player.isHost)
      };
    } else {
      list.push({
        id: player.id,
        name: player.name,
        isSpectator: Boolean(player.isSpectator),
        isHost: Boolean(player.isHost),
        hasVoted: false,
        vote: null
      });
    }
    if (player.isSpectator) {
      app.hostVotes.set(player.id, null);
    } else if (player.initialVote !== undefined && player.initialVote !== null && !app.roomState.revealed) {
      const validCard = DECK_CARDS.some((c) => c.value === player.initialVote);
      if (validCard) {
        app.hostVotes.set(player.id, player.initialVote);
      }
    } else if (!app.hostVotes.has(player.id)) {
      app.hostVotes.set(player.id, null);
    }
  }

  function hostRemoveParticipant(playerId, connToVerify) {
    // Only remove if the closed connection is still the active connection for this player
    if (connToVerify && app.clientConns.get(playerId) && app.clientConns.get(playerId) !== connToVerify) {
      logDebug('HostConn', 'Ignoring close event from superseded connection for playerId=' + playerId);
      return;
    }
    logDebug('HostConn', 'Removing disconnected participant playerId=' + playerId);
    app.roomState.participants = app.roomState.participants.filter((p) => p.id !== playerId);
    app.hostVotes.delete(playerId);
    app.clientConns.delete(playerId);
    hostSyncAll();
  }

  function hostHandleAction(playerId, msg) {
    if (!msg || typeof msg.type !== 'string') return;
    logDebug('Action', 'Host processing action "' + msg.type + '" from playerId=' + playerId, msg);

    switch (msg.type) {
      case 'JOIN': {
        hostUpsertParticipant({
          id: playerId,
          name: String(msg.name || 'Guest').slice(0, 24),
          isSpectator: Boolean(msg.isSpectator),
          isHost: playerId === app.playerId,
          initialVote: msg.currentVote
        });
        hostSyncAll();
        break;
      }
      case 'CAST_VOTE': {
        if (app.roomState.revealed) {
          logWarn('Action', 'Ignored CAST_VOTE because round is already revealed');
          return;
        }
        const participant = app.roomState.participants.find((p) => p.id === playerId);
        if (!participant || participant.isSpectator) {
          logWarn('Action', 'Ignored CAST_VOTE from unknown or spectator playerId=' + playerId);
          return;
        }
        const validCard = DECK_CARDS.some((c) => c.value === msg.vote);
        app.hostVotes.set(playerId, validCard ? msg.vote : null);
        hostSyncAll();
        break;
      }
      case 'REVEAL': {
        app.roomState.revealed = true;
        hostSyncAll();
        break;
      }
      case 'RESET': {
        app.roomState.revealed = false;
        app.roomState.round = (app.roomState.round || 1) + 1;
        app.hostVotes.forEach((_, key) => {
          app.hostVotes.set(key, null);
        });
        hostSyncAll();
        break;
      }
      case 'SET_STORY': {
        app.roomState.story = String(msg.story || '').slice(0, 120);
        hostSyncAll();
        break;
      }
      case 'SET_SPECTATOR': {
        const participant = app.roomState.participants.find((p) => p.id === playerId);
        if (!participant) return;
        participant.isSpectator = Boolean(msg.isSpectator);
        if (participant.isSpectator) {
          app.hostVotes.set(playerId, null);
        }
        hostSyncAll();
        break;
      }
      default:
        break;
    }
  }

  function startHostSession(roomCode) {
    cleanupPeer();
    app.isHost = true;
    app.roomCode = roomCode;
    app.hostVotes.clear();

    const restored = loadHostRoomStateFromStorage(roomCode);
    app.roomState = {
      roomCode,
      round: restored && restored.round ? restored.round : 1,
      story: restored && restored.story ? restored.story : '',
      revealed: restored ? Boolean(restored.revealed) : false,
      participants: []
    };

    if (restored && restored.votes && typeof restored.votes === 'object') {
      Object.keys(restored.votes).forEach((pid) => {
        app.hostVotes.set(pid, restored.votes[pid]);
      });
    }

    logDebug('HostInit', 'Starting host session for room ' + roomCode, {
      restoredState: Boolean(restored),
      round: app.roomState.round
    });

    hostUpsertParticipant({
      id: app.playerId,
      name: app.playerName,
      isSpectator: app.isSpectator,
      isHost: true,
      initialVote: app.myVote
    });

    setConnectionStatus('connecting', 'Starting room...');
    els.lobbySubmitBtn.disabled = true;

    const hostPeerId = PEER_PREFIX + roomCode;
    logDebug('PeerJS', 'Creating host Peer with ID=' + hostPeerId);
    const peer = new window.Peer(hostPeerId, PEER_CONFIG);
    app.peer = peer;

    peer.on('open', (id) => {
      logDebug('PeerJS', 'Host peer registered with broker, ID=' + id);
      els.lobbySubmitBtn.disabled = false;
      setConnectionStatus('connected', 'Hosting room');
      enterSessionView();
      hostSyncAll();
      showToast('Room ' + roomCode + ' is live. Copy the invite link to share with your team.');
    });

    peer.on('connection', (conn) => {
      let boundPlayerId = null;
      logDebug('HostConn', 'Incoming client WebRTC connection from peer=' + conn.peer);

      conn.on('data', (data) => {
        if (!data || typeof data !== 'object') return;
        if (data.type === 'PING') {
          if (conn.open) {
            conn.send({ type: 'PONG', timestamp: Date.now() });
          }
          return;
        }
        if (data.type === 'JOIN' && data.playerId) {
          boundPlayerId = String(data.playerId);
          app.clientConns.set(boundPlayerId, conn);
          logDebug('HostConn', 'Bound incoming connection to playerId=' + boundPlayerId + ' (' + data.name + ')');
        }
        const effectiveId = boundPlayerId || data.playerId;
        if (effectiveId) {
          hostHandleAction(effectiveId, data);
        }
      });

      conn.on('close', () => {
        logWarn('HostConn', 'Client connection closed for playerId=' + boundPlayerId);
        if (boundPlayerId) {
          hostRemoveParticipant(boundPlayerId, conn);
        }
      });

      conn.on('error', (err) => {
        logError('HostConn', 'Client connection error for playerId=' + boundPlayerId, err);
        if (boundPlayerId) {
          hostRemoveParticipant(boundPlayerId, conn);
        }
      });
    });

    peer.on('disconnected', () => {
      logWarn('PeerJS', 'Host disconnected from signaling broker. Attempting reconnect...');
      setConnectionStatus('connecting', 'Reconnecting...');
      peer.reconnect();
    });

    peer.on('error', (err) => {
      logError('PeerJS', 'Host peer error:', err);
      els.lobbySubmitBtn.disabled = false;
      if (err && err.type === 'unavailable-id') {
        logWarn('PeerJS', 'Host ID ' + hostPeerId + ' is still held on broker. Retrying in 2.5s...');
        setConnectionStatus('connecting', 'Reclaiming room...');
        app.reconnectTimer = setTimeout(() => {
          startHostSession(roomCode);
        }, 2500);
        return;
      }
      setConnectionStatus('disconnected', 'Connection error');
      setLobbyError('Could not initialize peer connection: ' + (err.message || err.type || 'Unknown error'));
    });
  }

  // Client Logic
  function scheduleClientReconnect(roomCode, reason) {
    if (app.isHost) return;
    if (els.lobbyView && !els.lobbyView.classList.contains('hidden')) return;
    if (app.reconnectTimer) return;

    logWarn('ClientReconnect', 'Scheduling reconnect to room ' + roomCode + ' in ' + RECONNECT_DELAY_MS + 'ms. Reason: ' + reason);
    app.hostConnOpen = false;
    setConnectionStatus('connecting', 'Reconnecting to host...');

    app.reconnectTimer = setTimeout(() => {
      app.reconnectTimer = null;
      if (!app.peer || app.peer.destroyed) {
        logDebug('ClientReconnect', 'Peer was destroyed; recreating client session');
        startClientSession(roomCode);
      } else if (app.peer.disconnected) {
        logDebug('ClientReconnect', 'Peer disconnected from broker; calling peer.reconnect()');
        app.peer.reconnect();
        connectClientToHost(roomCode);
      } else {
        connectClientToHost(roomCode);
      }
    }, RECONNECT_DELAY_MS);
  }

  function startClientHeartbeat(roomCode) {
    if (app.heartbeatTimer) {
      clearInterval(app.heartbeatTimer);
    }
    app.lastHostPongAt = Date.now();
    app.heartbeatTimer = setInterval(() => {
      if (app.isHost) return;
      if (!app.hostConn || !app.hostConn.open || !app.hostConnOpen) {
        logWarn('Heartbeat', 'Host connection is not open; triggering reconnect');
        scheduleClientReconnect(roomCode, 'Connection not open during heartbeat');
        return;
      }
      const elapsed = Date.now() - app.lastHostPongAt;
      if (elapsed > HEARTBEAT_TIMEOUT_MS) {
        logWarn('Heartbeat', 'No PONG from host for ' + elapsed + 'ms; closing stale connection and reconnecting');
        try {
          app.hostConn.close();
        } catch (_) {}
        scheduleClientReconnect(roomCode, 'Host heartbeat timeout (' + elapsed + 'ms)');
        return;
      }
      try {
        app.hostConn.send({ type: 'PING', playerId: app.playerId, timestamp: Date.now() });
      } catch (err) {
        logError('Heartbeat', 'Failed to send PING to host', err);
        scheduleClientReconnect(roomCode, 'PING send failure');
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  function startClientSession(roomCode) {
    cleanupPeer();
    app.isHost = false;
    app.roomCode = roomCode;

    logDebug('ClientInit', 'Starting client session for room ' + roomCode);
    setConnectionStatus('connecting', 'Joining room...');
    els.lobbySubmitBtn.disabled = true;

    const peer = new window.Peer(undefined, PEER_CONFIG);
    app.peer = peer;

    peer.on('open', (id) => {
      logDebug('PeerJS', 'Client peer registered with broker, ID=' + id);
      connectClientToHost(roomCode);
    });

    peer.on('disconnected', () => {
      logWarn('PeerJS', 'Client disconnected from signaling broker. Reconnecting...');
      setConnectionStatus('connecting', 'Reconnecting...');
      peer.reconnect();
    });

    peer.on('error', (err) => {
      logError('PeerJS', 'Client peer error:', err);
      els.lobbySubmitBtn.disabled = false;
      if (err && err.type === 'peer-unavailable') {
        app.hostConnOpen = false;
        if (!els.lobbyView.classList.contains('hidden')) {
          setConnectionStatus('disconnected', 'Room not found');
          setLobbyError('Room "' + roomCode + '" was not found or the host is offline.');
        } else {
          setConnectionStatus('connecting', 'Waiting for host...');
          scheduleClientReconnect(roomCode, 'Host peer unavailable on signaling server');
        }
        return;
      }
      setConnectionStatus('disconnected', 'Connection error');
      setLobbyError('Connection error: ' + (err.message || err.type || 'Unknown error'));
    });
  }

  function connectClientToHost(roomCode) {
    if (!app.peer || app.peer.destroyed) return;
    if (app.hostConn) {
      try {
        app.hostConn.close();
      } catch (_) {}
      app.hostConn = null;
    }

    const hostPeerId = PEER_PREFIX + roomCode;
    logDebug('ClientConn', 'Connecting to host Peer ID=' + hostPeerId);
    const conn = app.peer.connect(hostPeerId, { reliable: true });
    app.hostConn = conn;
    app.hostConnOpen = false;

    conn.on('open', () => {
      logDebug('ClientConn', 'WebRTC DataChannel open with host ' + hostPeerId);
      app.hostConnOpen = true;
      app.lastHostPongAt = Date.now();
      els.lobbySubmitBtn.disabled = false;
      setConnectionStatus('connected', 'Connected');
      enterSessionView();
      startClientHeartbeat(roomCode);
      conn.send({
        type: 'JOIN',
        playerId: app.playerId,
        name: app.playerName,
        isSpectator: app.isSpectator,
        currentVote: app.myVote
      });
    });

    conn.on('data', (data) => {
      if (!data || typeof data !== 'object') return;
      app.lastHostPongAt = Date.now();
      if (data.type === 'PONG') {
        return;
      }
      if (data.type === 'STATE_SYNC' && data.state) {
        logDebug('ClientSync', 'Received STATE_SYNC from host', {
          round: data.state.round,
          revealed: data.state.revealed,
          participantsCount: (data.state.participants || []).length,
          yourVote: data.yourVote
        });
        app.roomState = data.state;
        if (data.yourVote !== undefined) {
          app.myVote = data.yourVote;
        }
        const me = app.roomState.participants.find((p) => p.id === app.playerId);
        if (me) {
          app.isSpectator = Boolean(me.isSpectator);
        }
        saveSessionToStorage();
        renderSessionUI();
      }
    });

    conn.on('close', () => {
      logWarn('ClientConn', 'WebRTC DataChannel closed with host');
      app.hostConnOpen = false;
      setConnectionStatus('disconnected', 'Disconnected from host');
      scheduleClientReconnect(roomCode, 'DataChannel close event');
    });

    conn.on('error', (err) => {
      logError('ClientConn', 'WebRTC DataChannel error with host:', err);
      app.hostConnOpen = false;
      scheduleClientReconnect(roomCode, 'DataChannel error event');
    });
  }

  function dispatchAction(action) {
    logDebug('Dispatch', 'Dispatching user action:', action);
    if (app.isHost) {
      hostHandleAction(app.playerId, action);
    } else if (app.hostConn && app.hostConn.open && app.hostConnOpen) {
      app.hostConn.send({
        ...action,
        playerId: app.playerId
      });
    } else {
      logWarn('Dispatch', 'Cannot send action while disconnected from host:', action);
      showToast('Host is offline. Reconnecting automatically...');
      scheduleClientReconnect(app.roomCode, 'User action while disconnected');
    }
  }

  // User Interactions
  function handleCardClick(cardValue) {
    if (app.isSpectator || app.roomState.revealed) return;
    const nextVote = app.myVote === cardValue ? null : cardValue;
    app.myVote = nextVote;
    saveSessionToStorage();
    updateDeckUI();
    dispatchAction({
      type: 'CAST_VOTE',
      vote: nextVote
    });
  }

  function handleCopyInviteLink() {
    const url = new URL(window.location.href);
    url.searchParams.set('room', app.roomCode);
    const inviteUrl = url.toString();

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(inviteUrl).then(() => {
        showToast('Invite link copied to clipboard!');
      }).catch(() => {
        showToast('Room code: ' + app.roomCode);
      });
    } else {
      showToast('Room code: ' + app.roomCode);
    }
  }

  function handleLeaveRoom() {
    logDebug('Session', 'User clicked Leave Room');
    cleanupPeer();
    clearSessionStorage();
    updateUrlRoomParam('');
    els.sessionView.classList.add('hidden');
    els.sessionHeaderControls.classList.add('hidden');
    els.lobbyView.classList.remove('hidden');
    els.lobbySubmitBtn.disabled = false;
    setLobbyMode('create');
  }

  function initEventListeners() {
    els.tabCreateBtn.addEventListener('click', () => setLobbyMode('create'));
    els.tabJoinBtn.addEventListener('click', () => setLobbyMode('join'));

    els.lobbyForm.addEventListener('submit', (e) => {
      e.preventDefault();
      setLobbyError('');

      const name = els.playerNameInput.value.trim();
      if (!name) {
        setLobbyError('Please enter your display name.');
        els.playerNameInput.focus();
        return;
      }

      app.playerName = name.slice(0, 24);
      app.isSpectator = Boolean(els.spectatorCheckbox.checked);
      if (!app.playerId) {
        app.playerId = generatePlayerId();
      }

      if (app.mode === 'create') {
        const newCode = generateRoomCode();
        startHostSession(newCode);
      } else {
        const code = normalizeRoomCode(els.roomCodeInput.value);
        if (code.length < 4) {
          setLobbyError('Please enter a valid room code.');
          els.roomCodeInput.focus();
          return;
        }
        startClientSession(code);
      }
    });

    els.copyInviteBtn.addEventListener('click', handleCopyInviteLink);

    els.toggleSpectatorBtn.addEventListener('click', () => {
      app.isSpectator = !app.isSpectator;
      if (app.isSpectator) {
        app.myVote = null;
      }
      saveSessionToStorage();
      dispatchAction({
        type: 'SET_SPECTATOR',
        isSpectator: app.isSpectator
      });
    });

    els.leaveRoomBtn.addEventListener('click', handleLeaveRoom);

    els.revealBtn.addEventListener('click', () => {
      dispatchAction({ type: 'REVEAL' });
    });

    els.resetBtn.addEventListener('click', () => {
      dispatchAction({ type: 'RESET' });
    });

    let storyDebounce = null;
    els.storyTitleInput.addEventListener('input', () => {
      clearTimeout(storyDebounce);
      const val = els.storyTitleInput.value;
      storyDebounce = setTimeout(() => {
        dispatchAction({
          type: 'SET_STORY',
          story: val
        });
      }, 220);
    });

    // Cleanly close PeerJS connections when tab is closed or refreshed
    window.addEventListener('beforeunload', () => {
      logDebug('Lifecycle', 'Window beforeunload fired; closing connections');
      cleanupPeer();
    });
  }

  function initApp() {
    renderDeck();
    initEventListeners();

    try {
      const savedName = localStorage.getItem(STORAGE_NAME_KEY);
      if (savedName) {
        els.playerNameInput.value = savedName;
      }
    } catch (_) {}

    const params = new URLSearchParams(window.location.search);
    const urlRoom = normalizeRoomCode(params.get('room'));

    try {
      const rawSession =
        sessionStorage.getItem(STORAGE_SESSION_KEY) ||
        (urlRoom ? localStorage.getItem(STORAGE_SESSION_KEY + '_' + urlRoom) : null);

      if (rawSession) {
        const savedSession = JSON.parse(rawSession);
        if (savedSession && savedSession.roomCode && (!urlRoom || savedSession.roomCode === urlRoom)) {
          logDebug('Init', 'Restoring saved session from storage:', savedSession);
          app.playerId = savedSession.playerId || generatePlayerId();
          app.playerName = savedSession.playerName || els.playerNameInput.value || 'Player';
          app.isSpectator = Boolean(savedSession.isSpectator);
          app.myVote = savedSession.myVote ?? null;
          els.playerNameInput.value = app.playerName;
          els.spectatorCheckbox.checked = app.isSpectator;
          if (savedSession.isHost) {
            startHostSession(savedSession.roomCode);
          } else {
            startClientSession(savedSession.roomCode);
          }
          return;
        }
      }
    } catch (_) {}

    if (urlRoom) {
      setLobbyMode('join');
      els.roomCodeInput.value = urlRoom;
    } else {
      setLobbyMode('create');
    }
  }

  document.addEventListener('DOMContentLoaded', initApp);
})();
