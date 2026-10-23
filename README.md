# Planning Poker

This application is a web-based Planning Poker tool for remote Agile teams. It runs on GitHub Pages and uses PeerJS (WebRTC) for real-time peer-to-peer communication with zero server or hosting costs.

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
