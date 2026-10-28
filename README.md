# Planning Poker

This application is a web-based Planning Poker tool for remote Agile teams. It runs on GitHub Pages and uses PeerJS (WebRTC) for real-time peer-to-peer communication with zero server or hosting costs.

> **Generation Note:** This project was generated with **Google Antigravity** (version `1.4.6`) using the **Gemini 4 Argon (Medium)** model.

## Live Application

- **URL:** [https://nimeshnischal.github.io/planning-poker/](https://nimeshnischal.github.io/planning-poker/)

## Features

- **Zero Cost and No Account Required:** Uses static hosting on GitHub Pages and direct browser-to-browser WebRTC data channels.
- **Standard Fibonacci Deck:** Includes `0`, `1`, `2`, `3`, `5`, `8`, `13`, `21`, `?`, and `Coffee`.
- **Shareable Invite Links:** Copy the room link to let team members join the session immediately.
- **Secret Voting:** Keeps individual votes hidden until a participant clicks **Reveal Cards**.
- **Automatic Statistics:** Calculates the average, median, consensus percentage, and vote distribution when cards are revealed.
- **Spectator Mode:** Allows facilitators or product managers to observe the session without affecting vote statistics.

## How to Use

1. Open the application URL.
2. Enter your display name and click **Create Room**.
3. Click **Copy Invite Link** in the top navigation bar and send the link to your team.
4. Enter a story title or ticket ID at the top of the screen.
5. Each voter selects a card from the deck at the bottom.
6. Click **Reveal Cards** to view all votes and round statistics.
7. Click **New Round** to clear votes and estimate the next story.

---

## How PeerJS Works

PeerJS is a wrapper around **WebRTC (Web Real-Time Communication)** data channels. It enables browsers to exchange data directly without routing application messages through a backend server:

1. **Signaling (Discovery):**
   - When the host creates a room, the browser registers a Peer ID (`pp-v1-room-<ROOM_CODE>`) with the public PeerServer Cloud broker (`0.peerjs.com`) over a WebSocket connection.
   - When a client joins the room, the signaling broker forwards **Session Description Protocol (SDP)** offer and answer packets between the client and the host. The signaling broker never receives voting data.
2. **NAT Traversal (STUN and ICE):**
   - Each browser queries the configured Google STUN servers (`stun.l.google.com:19302`) to discover its public IP address and port.
   - Browsers exchange **Interactive Connectivity Establishment (ICE)** candidates and perform UDP hole punching through their routers.
3. **Direct Data Channel (SCTP over DTLS/UDP):**
   - After NAT traversal succeeds, WebRTC opens a direct `RTCDataChannel` encrypted with **DTLS (Datagram Transport Layer Security)** in reliable mode (`{ reliable: true }`).

---

## Architecture Review: Scalability and Load Handling

### Star Network Topology (Host-Authoritative)

The application uses a **Star Topology**:
- The room creator acts as the central host node and maintains the authoritative room state in memory.
- Every client maintains **1** WebRTC connection to the host, and the host maintains **$N - 1$** connections for $N$ participants. This avoids the $\frac{N(N - 1)}{2}$ connection overhead of a full mesh network.

### Load Limits

| Metric | Practical Limit | Bottleneck Cause |
| :--- | :--- | :--- |
| **Players per Room** | ~15 to 25 players | Host browser CPU, upload bandwidth, and broadcast fan-out. |
| **Concurrent Rooms** | Thousands | Rooms are isolated from each other. Only initial signaling uses the public PeerJS broker. |
| **Payload Size** | ~1 to 3 KB per sync | Full room state snapshot is sent on each state change. |

### Bottlenecks and Trade-offs

1. **Host Broadcast Fan-Out:** On each state update, `hostSyncAll` builds and sends a state snapshot to each connected client. This is fast for standard Scrum teams (5 to 15 people), but scales as $O(N^2)$ work on the host for very large rooms.
2. **Host Browser as Single Point of Failure:** Because room state resides in the host browser memory, the session ends if the host closes their browser or loses connectivity permanently. Page refreshes on the host recover the room code from `sessionStorage`, and clients automatically reconnect.
3. **Strict Corporate Firewalls (No TURN Server):** Public STUN servers work across roughly 80% to 85% of networks. Symmetric NATs or restrictive corporate firewalls that block UDP hole punching require a paid **TURN** relay server.
4. **DOM Re-rendering:** The participant grid rebuilds its DOM nodes on each state synchronization. This is instantaneous for normal team sizes.

---

## Security Review

### Security Controls Implemented

1. **Cross-Site Scripting (XSS) Protection:** All untrusted strings (player names, story titles, and room codes) are rendered with `textContent` and input `.value` properties. `innerHTML` is never used with user data.
2. **Subresource Integrity (SRI):** The external `peerjs.min.js` script tag in `index.html` uses `integrity="sha384-..."` and `crossorigin="anonymous"` so the browser blocks execution if the CDN file is modified.
3. **Cryptographically Strong IDs:** Room codes and player IDs are generated with `window.crypto.getRandomValues` instead of `Math.random()`.
4. **Network-Level Vote Secrecy:** Before cards are revealed, `buildHostBroadcastState` strips all vote values (`vote: null`) and sends only `hasVoted: true | false` to connected peers.
5. **Input Validation:** The host validates all cast votes against the allowed `DECK_CARDS` list and enforces length limits on player names (24 characters) and story titles (120 characters).

### Known Limitations and Future Hardening

1. **Collaborative Action Permissions:** Any connected participant can trigger `REVEAL`, `RESET`, or `SET_STORY`. Teams that want strict control can restrict these actions to the host only.
2. **Player ID Spoofing:** A client supplies its `playerId` when sending `JOIN`. Assigning connection-scoped tokens on the host would prevent a malicious peer from impersonating another `playerId`.
3. **Room Access Control:** Anyone with the 6-character room code (32-character alphabet, $32^6 \approx 1.07 \times 10^9$ combinations) can join. Adding an optional room password or host admission prompt would add access control.
4. **Host Memory Inspection:** Because the host browser stores unrevealed votes in `app.hostVotes`, the host user could inspect memory in browser DevTools prior to reveal. A cryptographic commit-reveal scheme (`SHA-256(vote + salt)`) would prevent host inspection.

---

## License

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for details.
