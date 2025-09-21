// gameEngine.js
// Simple game engine for "пенёк" variant you described.
// JS (no TS) — meant to be run on Node server side (authoritative).

const DEFAULT_CONFIG = {
  use52: false, // false -> 36 cards (6..A)
  handSizeOnDeal: 1, // initial open card count (we will give each player 1 open + 2 penki + maybe more later)
  fullHandSize: 6, // after each round players draw until this number (optional rule) - you can change
};

const SUITS = ['♠','♥','♦','♣'];
const RANKS36 = [6,7,8,9,10,11,12,13,14]; // 11=J,12=Q,13=K,14=A
const RANKS52 = [2,3,4,5,6,7,8,9,10,11,12,13,14];

function makeDeck(use52=false) {
  const ranks = use52 ? RANKS52 : RANKS36;
  const deck = [];
  for (const r of ranks) {
    for (const s of SUITS) {
      deck.push({ rank: r, suit: s, id: `${s}_${r}` });
    }
  }
  return shuffle(deck);
}

function shuffle(arr) {
  for (let i = arr.length-1; i>0; i--) {
    const j = Math.floor(Math.random() * (i+1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function cardToString(c){
  if(!c) return '??';
  const map = {11:'J',12:'Q',13:'K',14:'A'};
  return `${map[c.rank]||c.rank}${c.suit}`;
}

/* helper: compare ranks in linear order (6..A), we assume higher numeric = stronger */
function isHigherRank(aRank, bRank) {
  // aRank > bRank in normal numerical ordering
  return aRank > bRank;
}

/* can defence beat attack given trumpSuit and special spade rules */
function canBeat(attackCard, defenceCard, trumpSuit, use52=false) {
  if (!attackCard || !defenceCard) return false;
  // 7♠ special: 7 of spades beats any card when played as defense (we handle close-round elsewhere)
  // But defending to beat 7♠? 7♠ as attack acts as winning card; rule: 7♠ бьёт любую карту и закрывает круг моментально.
  // Spade-specific: if attack is spade, only spade can beat it.
  if (attackCard.suit === '♠') {
    if (defenceCard.suit !== '♠') return false;
    return isHigherRank(defenceCard.rank, attackCard.rank);
  }
  // Normal case: same suit and higher rank OR defence is trump (if attack is not spade and trump exists and defence is trump)
  if (defenceCard.suit === attackCard.suit && isHigherRank(defenceCard.rank, attackCard.rank)) return true;
  if (trumpSuit && defenceCard.suit === trumpSuit && attackCard.suit !== '♠') return true;
  return false;
}

class Player {
  constructor(id, socketId, name='Player') {
    this.id = id;
    this.socketId = socketId || null;
    this.name = name;
    this.hand = []; // visible/usable cards
    this.penki = []; // 2 hidden cards
    this.openCard = null; // single open card for starter determination
    this.out = false; // finished round (no cards and no penki)
    this.penekCount = 0; // count across games
  }
}

class Game {
  constructor(id, config = {}) {
    this.id = id;
    this.config = Object.assign({}, DEFAULT_CONFIG, config);
    this.players = []; // ordered array
    this.deck = [];
    this.discard = []; // отбои
    this.stack = []; // linear stack: bottom = index 0, top = last
    this.trump = null; // suit or null
    this.lastDrawerIndex = null; // who last drew card for trump determination (index)
    this.currentAttacker = 0; // index in players
    this.currentDefender = 1; // index in players
    this.started = false;
    this.logs = [];
  }

  log(...args){
    const s = args.map(a => typeof a==='object' ? JSON.stringify(a) : String(a)).join(' ');
    this.logs.push(s);
    if(this.logs.length>200) this.logs.shift();
  }

  addPlayer(id, socketId, name='Player'){
    if(this.started) throw new Error('Game already started');
    const p = new Player(id, socketId, name);
    this.players.push(p);
    return p;
  }

  removePlayerBySocket(socketId){
    const idx = this.players.findIndex(p=>p.socketId===socketId);
    if(idx>=0) this.players.splice(idx,1);
  }

  getPlayerIndexById(id){
    return this.players.findIndex(p => p.id === id);
  }

  getNextIndex(idx){
    if(this.players.length===0) return -1;
    return (idx + 1) % this.players.length;
  }

  dealInitial(){
    this.deck = makeDeck(this.config.use52);
    // deal penki (2 hidden) to each player
    for (const p of this.players){
      p.penki = [ this.deck.pop(), this.deck.pop() ];
    }
    // deal 1 open card each (for starter determination)
    for (const p of this.players){
      p.openCard = this.deck.pop();
    }
    // optionally give each player some initial hand cards (we'll keep hand empty; players will draw later as per rules)
  }

  determineFirstDrawer(){
    // find highest openCard by rank; if tie - draw more for tied players until resolved
    let maxRank = -Infinity;
    let candidates = [];
    for (let i=0;i<this.players.length;i++){
      const r = this.players[i].openCard.rank;
      if (r > maxRank) { maxRank = r; candidates = [i]; }
      else if (r === maxRank) candidates.push(i);
    }
    if (candidates.length === 1) {
      return candidates[0];
    }
    // tie -> among candidates draw one additional card from deck (revealed) for each until resolved
    while (candidates.length > 1 && this.deck.length > 0) {
      const revealed = [];
      for (const idx of candidates){
        const c = this.deck.pop();
        revealed.push({ idx, card: c });
      }
      // find highest among revealed
      let highest = -Infinity;
      let newCandidates = [];
      for (const r of revealed){
        if (r.card.rank > highest) { highest = r.card.rank; newCandidates = [r.idx]; }
        else if (r.card.rank === highest) newCandidates.push(r.idx);
      }
      candidates = newCandidates;
      // continue if tie remains
    }
    // if still tie and deck empty -> pick first candidate
    return candidates[0] || 0;
  }

  start(){
    if (this.players.length < 2) throw new Error('Need >=2 players');
    this.dealInitial();
    const drawerIndex = this.determineFirstDrawer();
    // that drawer draws a card from deck — we consider "last drawer for trump determination" the one who draws after tie resolution
    const drawn = this.deck.pop();
    if (drawn) {
      this.lastDrawerIndex = drawerIndex;
      this.trump = (drawn.suit === '♠' ? null : drawn.suit); // spade can't be trump
      // the last drawn card's suit is trump (unless spade)
      this.discard.push(drawn); // reveal? we store it in discard for history
    }
    // this person who last drew starts as attacker
    this.currentAttacker = drawerIndex;
    this.currentDefender = this.getNextIndex(drawerIndex);
    this.started = true;
    this.log('Game started', {drawerIndex, trump: this.trump});
  }

  /* helper to get player by index (accounting removal) */
  playerAt(idx){
    if (this.players.length===0) return null;
    return this.players[idx % this.players.length];
  }

  // attacker plays a card from their hand onto the stack to attack defender
  playCard(playerId, cardId){
    if (!this.started) throw new Error('Game not started');
    const attackerIdx = this.getPlayerIndexById(playerId);
    if (attackerIdx !== this.currentAttacker) throw new Error('Not your turn to attack');
    const attacker = this.players[attackerIdx];
    // attacker must have card in hand
    const ci = attacker.hand.findIndex(c => c.id === cardId);
    if (ci < 0) throw new Error('Card not in hand');
    const card = attacker.hand.splice(ci,1)[0];
    this.stack.push(card);
    this.log(`${attacker.name} attacks with ${cardToString(card)}`);
    // after attack, defender is currentDefender (must try to beat top card)
    // if attacker emptied hand and had penki? we handle later when round closes
    // special: if card is 7 of spades, it closes round instantly
    if (card.suit==='♠' && card.rank===7){
      this.log('7♠ played - instant close by attacker');
      return this.closeRoundBy(attackerIdx);
    }
    return { status: 'ok', stack: this.stack.slice() };
  }

  // defender tries to beat top card using defenceCardId from his hand
  defendWith(playerId, defenceCardId){
    if (!this.started) throw new Error('Game not started');
    const defenderIdx = this.getPlayerIndexById(playerId);
    if (defenderIdx !== this.currentDefender) throw new Error('Not your turn to defend');
    const defender = this.players[defenderIdx];
    if (this.stack.length===0) throw new Error('Nothing to defend');
    const attackCard = this.stack[this.stack.length-1];
    const di = defender.hand.findIndex(c => c.id === defenceCardId);
    if (di < 0) throw new Error('Defence card not in hand');
    const defenceCard = defender.hand[di];
    // Check special: if defenceCard is 7♠ it beats any card and closes round immediately
    if (defenceCard.suit==='♠' && defenceCard.rank===7){
      // remove card from hand
      defender.hand.splice(di,1);
      this.stack.push(defenceCard);
      this.log(`${defender.name} defended with 7♠ - instant close`);
      return this.closeRoundBy(defenderIdx);
    }
    // Normal canBeat check
    if (!canBeat(attackCard, defenceCard, this.trump, this.config.use52)){
      throw new Error('Cannot beat this attack with chosen card');
    }
    // valid defence
    defender.hand.splice(di,1);
    this.stack.push(defenceCard);
    this.log(`${defender.name} beat ${cardToString(attackCard)} with ${cardToString(defenceCard)}`);
    // If everyone in sequence has defended on their turns and round closes accordingly, handle outside.
    // After successful defence, the next attacker in circle becomes attacker, next defender becomes next player (rotate)
    const prevAttacker = this.currentAttacker;
    this.currentAttacker = this.getNextIndex(this.currentAttacker);
    this.currentDefender = this.getNextIndex(this.currentAttacker);
    // check if round is closed (everyone managed to defend in full cycle). We'll define closing as: 
    // when defender index loops back to the player who closed (we'll call endRoundIfClosed manually in server after actions).
    return { status: 'defended', stack: this.stack.slice(), currentAttacker: this.currentAttacker, currentDefender: this.currentDefender };
  }

  // if defender cannot defend -> he takes bottom card (index 0) into his hand
  takeBottom(playerId){
    const defenderIdx = this.getPlayerIndexById(playerId);
    if (defenderIdx !== this.currentDefender) throw new Error('Not your turn to take');
    const defender = this.players[defenderIdx];
    if (this.stack.length === 0) throw new Error('No cards on stack to take');
    const bottom = this.stack.shift(); // remove bottom
    defender.hand.push(bottom);
    this.log(`${defender.name} could not defend and took bottom ${cardToString(bottom)}`);
    // turn passes to next player; rotate attacker to next player after defender
    this.currentAttacker = this.getNextIndex(this.currentAttacker);
    this.currentDefender = this.getNextIndex(this.currentAttacker);
    // Note: we leave remaining stack as is (per your rule)
    return { status: 'took', taken: bottom, stack: this.stack.slice(), currentAttacker: this.currentAttacker, currentDefender: this.currentDefender };
  }

  // close round: all cards from stack go to discard, stack cleared. Player who closed round becomes next attacker.
  closeRoundBy(playerIdx){
    // move stack to discard
    while (this.stack.length) this.discard.push(this.stack.shift());
    // playerIdx becomes attacker for next round
    this.currentAttacker = playerIdx;
    this.currentDefender = this.getNextIndex(playerIdx);
    // after round close, players who have fewer cards draw from deck until fullHandSize (optional)
    this.replenishHands();
    // reveal penki if someone has hand empty and round closed - they get their penki into hand
    this.revealPenkiWhereNeeded();
    this.log(`Round closed by player index ${playerIdx}. Trump remains ${this.trump}`);
    return { status: 'closed', currentAttacker: this.currentAttacker, currentDefender: this.currentDefender };
  }

  replenishHands(){
    // standard rule: each player draws from deck until they have fullHandSize or deck empty
    for (const p of this.players){
      while (p.hand.length < this.config.fullHandSize && this.deck.length > 0){
        p.hand.push(this.deck.pop());
      }
    }
  }

  revealPenkiWhereNeeded(){
    // If player has 0 cards and the round closed (we already closed), then give him his penki into hand (and clear penki)
    for (const p of this.players){
      if (p.hand.length === 0 && p.penki && p.penki.length>0){
        p.hand.push(...p.penki);
        p.penki = [];
        this.log(`${p.name} took penki into hand`);
      }
    }
    // mark out players who have no cards and no penki
    for (const p of this.players){
      if (p.hand.length===0 && (!p.penki || p.penki.length===0)){
        p.out = true;
      }
    }
  }

  // utility to get public game state to send to clients (hide penki)
  publicStateFor(socketPlayerId){
    // identify player by id
    const meIndex = this.players.findIndex(p => p.id === socketPlayerId);
    return {
      id: this.id,
      trump: this.trump,
      deckSize: this.deck.length,
      discardSize: this.discard.length,
      stack: this.stack.map(cardToString),
      players: this.players.map((p, idx) => ({
        id: p.id,
        name: p.name,
        handCount: p.hand.length,
        hand: (idx===meIndex) ? p.hand.map(cardToString) : p.hand.map(_=> '##'), // only reveal hand to owner
        penkiCount: p.penki.length,
        openCard: p.openCard ? cardToString(p.openCard) : null,
        out: p.out,
        penekCount: p.penekCount
      })),
      currentAttacker: this.currentAttacker,
      currentDefender: this.currentDefender,
      logs: this.logs.slice(-30)
    };
  }
}

module.exports = { Game, makeDeck, Player, canBeat, cardToString };
