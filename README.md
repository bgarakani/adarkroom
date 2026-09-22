A Dark Room
===========
> "awake. head throbbing. vision blurry. come light the fire."

a minimalist text adventure game for your browser

[Click to play](http://adarkroom.doublespeakgames.com)

<table>
<tr><th colspan=4>Available Languages</tr>
<tr>
	<td><a href="http://adarkroom.doublespeakgames.com/?lang=zh_cn">Chinese (Simplified)</a></td>
	<td><a href="http://adarkroom.doublespeakgames.com/?lang=zh_tw">Chinese (Traditional)</a></td>
	<td><a href="http://adarkroom.doublespeakgames.com/?lang=en">English</a></td>
	<td><a href="http://adarkroom.doublespeakgames.com/?lang=fr">French</a></td>
</tr><tr>
	<td><a href="http://adarkroom.doublespeakgames.com/?lang=de">German</a></td>
	<td><a href="http://adarkroom.doublespeakgames.com/?lang=el">Greek</a></td>
	<td><a href="http://adarkroom.doublespeakgames.com/?lang=id">Indonesian</a></td>
	<td><a href="http://adarkroom.doublespeakgames.com/?lang=it">Italian</a></td>
</tr><tr>
	<td><a href="http://adarkroom.doublespeakgames.com/?lang=ja">Japanese</a></td>
	<td><a href="http://adarkroom.doublespeakgames.com/?lang=ko">Korean</a></td>
	<td><a href="http://adarkroom.doublespeakgames.com/?lang=nb">Norwegian</a></td>
	<td><a href="http://adarkroom.doublespeakgames.com/?lang=pl">Polish</a></td>
</tr><tr>
	<td><a href="http://adarkroom.doublespeakgames.com/?lang=pt">Portuguese</a></td>
	<td><a href="http://adarkroom.doublespeakgames.com/?lang=pt_br">Portuguese (Brazil)</a></td>
	<td><a href="http://adarkroom.doublespeakgames.com/?lang=ru">Russian</a></td>
	<td><a href="http://adarkroom.doublespeakgames.com/?lang=es">Spanish</a></td>
</tr><tr>
	<td><a href="http://adarkroom.doublespeakgames.com/?lang=sv">Swedish</a></td>
	<td><a href="http://adarkroom.doublespeakgames.com/?lang=th">Thai</a></td>
	<td><a href="http://adarkroom.doublespeakgames.com/?lang=tr">Turkish</a></td>
	<td><a href="http://adarkroom.doublespeakgames.com/?lang=uk">Ukrainian</a></td>
</tr><tr>
	<td><a href="http://adarkroom.doublespeakgames.com/?lang=vi">Vietnamese</a></td>
	<td><a href="http://adarkroom.doublespeakgames.com/?lang=lt_LT">Lithuanian</a></td>
	<td><a href="http://adarkroom.doublespeakgames.com/?lang=gl">Galician</a></td>
</tr>
</table>

or play the latest on [GitHub](http://doublespeakgames.github.io/adarkroom)

> **This fork adds designer tools:** a panel for tuning every number in the game
> while you play it, and a bot that plays the game by itself and records what it
> did. See [Designer tools](#designer-tools) below, or
> [designer/README.md](designer/README.md) for the full guide.

<a href="https://itunes.apple.com/us/app/a-dark-room/id736683061"><img src="http://i.imgur.com/DMdnDYq.png" height="50"></a>
<a href="https://play.google.com/store/apps/details?id=com.yourcompany.adarkroom"><img src="http://i.imgur.com/bLWWj4r.png" height="50"></a>
<a href="https://store.steampowered.com/app/2460660/A_Dark_Room/"><img src="https://i.imgur.com/yz6cnU0.png" height="50"></a>

Designer tools
==============

This fork adds two tools for studying and tuning the game's design. They run
next to the game and change nothing about how the original plays.

- **Tuning panel** — every number the game holds as data, editable in a form:
  how long before you can stoke the fire again, what a hut costs, what a trap
  drops, how much damage a beast does, how likely each outcome of an event is.
- **Autoplay bot** — plays the game on its own by rules (no AI), and writes a
  trace of every decision it made and why, so you can see how a change to the
  numbers changes the shape of a playthrough.

Setup
-----

You need [Node.js](https://nodejs.org) 18 or newer. Check with `node --version`.

```sh
git clone https://github.com/bgarakani/adarkroom.git
cd adarkroom
yarn install        # or: npm install
yarn designer       # or: npm run designer
```

Then open **http://localhost:8181**. The game is on the left, the tools on the
right. Nothing is sent anywhere — the server runs on your own machine only.

To play the plain, untouched game instead, run `yarn start` and open
http://localhost:8080.

Using it
--------

**Tuning tab.** Search for what you want to change (try `stoke`), type a new
value, and press **apply & reload**. Your saved game carries over. Changed
fields are highlighted and show their original value, and every change can be
undone. **export JSON** saves your settings to a file you can hand to someone
else, who loads it with **import JSON**.

**Bot tab.** Press **start fresh run** and watch it play. The milestone list
shows how long it took to reach each stage of the game, which is the quickest
way to see whether a tuning change made the opening faster or slower. Keep the
tab visible while it runs — browsers slow down background tabs.

Full instructions, the trace format, and how to change the bot's own strategy
are in **[designer/README.md](designer/README.md)**.
