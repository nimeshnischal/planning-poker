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
    clientConns: new Map(), // playerId -> DataConnection (host only)
    reconnectTimer: null,
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
    els.lobbyError.textContent = message;
    els.lobbyError.classList.remove('hidden');
  }

  function setConnectionStatus(state, label) {
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
      sessionStorage.setItem(
        STORAGE_SESSION_KEY,
        JSON.stringify({
          roomCode: app.roomCode,
          playerId: app.playerId,
          playerName: app.playerName,
          isSpectator: app.isSpectator,
          isHost: app.isHost
        })
      );
    } catch (_) {
      // Ignore storage errors in private browsing modes
    }
  }

  function clearSessionStorage() {
    try {
      sessionStorage.removeItem(STORAGE_SESSION_KEY);
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
    if (app.reconnectTimer) {
      clearTimeout(app.reconnectTimer);
      app.reconnectTimer = null;
    }
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
    // Sync host local view
    const selfPayload = buildHostBroadcastState(app.playerId);
    app.roomState = selfPayload.state;
    app.myVote = selfPayload.yourVote;
    renderSessionUI();

    // Broadcast to each connected client
    app.clientConns.forEach((conn, playerId) => {
      if (conn && conn.open) {
        conn.send(buildHostBroadcastState(playerId));
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
    } else if (!app.hostVotes.has(player.id)) {
      app.hostVotes.set(player.id, null);
    }
  }

  function hostRemoveParticipant(playerId) {
    app.roomState.participants = app.roomState.participants.filter((p) => p.id !== playerId);
    app.hostVotes.delete(playerId);
    app.clientConns.delete(playerId);
    hostSyncAll();
  }

  function hostHandleAction(playerId, msg) {
    if (!msg || typeof msg.type !== 'string') return;

    switch (msg.type) {
      case 'JOIN': {
        hostUpsertParticipant({
          id: playerId,
          name: String(msg.name || 'Guest').slice(0, 24),
          isSpectator: Boolean(msg.isSpectator),
          isHost: playerId === app.playerId
        });
        hostSyncAll();
        break;
      }
      case 'CAST_VOTE': {
        if (app.roomState.revealed) return;
        const participant = app.roomState.participants.find((p) => p.id === playerId);
        if (!participant || participant.isSpectator) return;
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
    app.myVote = null;
    app.hostVotes.clear();
    app.roomState = {
      roomCode,
      round: 1,
      story: '',
      revealed: false,
      participants: []
    };

    hostUpsertParticipant({
      id: app.playerId,
      name: app.playerName,
      isSpectator: app.isSpectator,
      isHost: true
    });

    setConnectionStatus('connecting', 'Starting room...');
    els.lobbySubmitBtn.disabled = true;

    const hostPeerId = PEER_PREFIX + roomCode;
    const peer = new window.Peer(hostPeerId, PEER_CONFIG);
    app.peer = peer;

    peer.on('open', () => {
      els.lobbySubmitBtn.disabled = false;
      setConnectionStatus('connected', 'Hosting room');
      enterSessionView();
      hostSyncAll();
      showToast('Room ' + roomCode + ' is live. Copy the invite link to share with your team.');
    });

    peer.on('connection', (conn) => {
      let boundPlayerId = null;

      conn.on('data', (data) => {
        if (!data || typeof data !== 'object') return;
        if (data.type === 'JOIN' && data.playerId) {
          boundPlayerId = String(data.playerId);
          app.clientConns.set(boundPlayerId, conn);
        }
        const effectiveId = boundPlayerId || data.playerId;
        if (effectiveId) {
          hostHandleAction(effectiveId, data);
        }
      });

      conn.on('close', () => {
        if (boundPlayerId) {
          hostRemoveParticipant(boundPlayerId);
        }
      });

      conn.on('error', () => {
        if (boundPlayerId) {
          hostRemoveParticipant(boundPlayerId);
        }
      });
    });

    peer.on('disconnected', () => {
      setConnectionStatus('connecting', 'Reconnecting...');
      peer.reconnect();
    });

    peer.on('error', (err) => {
      els.lobbySubmitBtn.disabled = false;
      if (err && err.type === 'unavailable-id') {
        // Generate a fresh code if collision occurs
        startHostSession(generateRoomCode());
        return;
      }
      setConnectionStatus('disconnected', 'Connection error');
      setLobbyError('Could not initialize peer connection: ' + (err.message || err.type || 'Unknown error'));
    });
  }

  // Client Logic
  function startClientSession(roomCode) {
    cleanupPeer();
    app.isHost = false;
    app.roomCode = roomCode;
    app.myVote = null;

    setConnectionStatus('connecting', 'Joining room...');
    els.lobbySubmitBtn.disabled = true;

    const peer = new window.Peer(undefined, PEER_CONFIG);
    app.peer = peer;

    peer.on('open', () => {
      connectClientToHost(roomCode);
    });

    peer.on('disconnected', () => {
      setConnectionStatus('connecting', 'Reconnecting...');
      peer.reconnect();
    });

    peer.on('error', (err) => {
      els.lobbySubmitBtn.disabled = false;
      if (err && err.type === 'peer-unavailable') {
        setConnectionStatus('disconnected', 'Room not found');
        if (!els.lobbyView.classList.contains('hidden')) {
          setLobbyError('Room "' + roomCode + '" was not found or the host is offline.');
        } else {
          showToast('Host disconnected or room closed.');
        }
        return;
      }
      setConnectionStatus('disconnected', 'Connection error');
      setLobbyError('Connection error: ' + (err.message || err.type || 'Unknown error'));
    });
  }

  function connectClientToHost(roomCode) {
    if (!app.peer || app.peer.destroyed) return;
    const hostPeerId = PEER_PREFIX + roomCode;
    const conn = app.peer.connect(hostPeerId, { reliable: true });
    app.hostConn = conn;

    conn.on('open', () => {
      els.lobbySubmitBtn.disabled = false;
      setConnectionStatus('connected', 'Connected');
      enterSessionView();
      conn.send({
        type: 'JOIN',
        playerId: app.playerId,
        name: app.playerName,
        isSpectator: app.isSpectator
      });
    });

    conn.on('data', (data) => {
      if (!data || typeof data !== 'object') return;
      if (data.type === 'STATE_SYNC' && data.state) {
        app.roomState = data.state;
        if (data.yourVote !== undefined) {
          app.myVote = data.yourVote;
        }
        const me = app.roomState.participants.find((p) => p.id === app.playerId);
        if (me) {
          app.isSpectator = Boolean(me.isSpectator);
        }
        renderSessionUI();
      }
    });

    conn.on('close', () => {
      setConnectionStatus('disconnected', 'Disconnected from host');
      if (els.lobbyView.classList.contains('hidden')) {
        app.reconnectTimer = setTimeout(() => {
          setConnectionStatus('connecting', 'Reconnecting to host...');
          connectClientToHost(roomCode);
        }, 2500);
      }
    });
  }

  function dispatchAction(action) {
    if (app.isHost) {
      hostHandleAction(app.playerId, action);
    } else if (app.hostConn && app.hostConn.open) {
      app.hostConn.send({
        ...action,
        playerId: app.playerId
      });
    } else {
      showToast('Not connected to room host. Waiting to reconnect...');
    }
  }

  // User Interactions
  function handleCardClick(cardValue) {
    if (app.isSpectator || app.roomState.revealed) return;
    const nextVote = app.myVote === cardValue ? null : cardValue;
    app.myVote = nextVote;
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
  }

  function initApp() {
    renderDeck();
    initEventListeners();

    // Load saved player name
    try {
      const savedName = localStorage.getItem(STORAGE_NAME_KEY);
      if (savedName) {
        els.playerNameInput.value = savedName;
      }
    } catch (_) {}

    const params = new URLSearchParams(window.location.search);
    const urlRoom = normalizeRoomCode(params.get('room'));

    // Check if user has an active session in this tab for the URL room
    try {
      const rawSession = sessionStorage.getItem(STORAGE_SESSION_KEY);
      if (rawSession) {
        const savedSession = JSON.parse(rawSession);
        if (savedSession && savedSession.roomCode && (!urlRoom || savedSession.roomCode === urlRoom)) {
          app.playerId = savedSession.playerId || generatePlayerId();
          app.playerName = savedSession.playerName || els.playerNameInput.value || 'Player';
          app.isSpectator = Boolean(savedSession.isSpectator);
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
