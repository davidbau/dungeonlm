// Real scenes captured from speedrun-2.input via capture-scenes.mjs.
// Cherry-picked to cover common gameplay categories: room-entry,
// container handling, combat, navigation, dark rooms, vehicles,
// endgame. Each scene is the exact text the game emits just before
// asking the player for input at that turn.
//
// Regenerate with:
//   node test/node-webgpu/capture-scenes.mjs \
//     --input test/node-webgpu/fixtures/speedrun-2.input \
//     --out /tmp/speedrun-scenes.json
// then hand-pick from that JSON.

export const SCENES = {

  opening: `Welcome to Dungeon.\t\t\tThis version created 2-Dec-81.
This is an open field west of a white house with a boarded front door.
There is a small mailbox here.
A rubber mat saying "Welcome to Dungeon!" lies by the door.`,

  kitchen: `This is the kitchen of the white house.  A table seems to have been
used recently for the preparation of food.  A passage leads to the
west, and a dark staircase can be seen leading upward.  To the east
is a small window which is open.
On the table is an elongated brown sack, smelling of hot peppers.
A bottle is sitting on the table.
The glass bottle contains:
  A quantity of water.`,

  livingRoom: `This is the living room.  There is a door to the east.  To the west
is a wooden door with strange gothic lettering, which appears to be
nailed shut.
In the center of the room is a large oriental rug.
There is a trophy case here.
On hooks above the mantelpiece hangs an elvish sword of great antiquity.
A battery-powered brass lantern is on the trophy case.
There is an issue of US NEWS & DUNGEON REPORT here.`,

  cellar: `This is a dark and damp cellar with a narrow passageway leading
east, and a crawlway to the south.  To the west is the bottom of
a steep metal ramp which is unclimbable.
Above you is an open trap door.
The door crashes shut, and you hear someone barring it.
Your sword is glowing with a faint blue glow.`,

  trollRoom: `This is a small room with passages off in all directions.  Bloodstains
and deep scratches (perhaps made by an axe) mar the walls.
A nasty-looking troll, brandishing a bloody axe, blocks all passages
out of the room.
Your sword has begun to glow very brightly.`,

  cyclopsRoom: `This is a room with an exit on the west side, and a staircase
leading up.
A cyclops, who looks prepared to eat horses (much less mere
adventurers), blocks the staircase.  From his state of health
and the bloodstains on the walls, you gather that he is not very
friendly, though he likes people.
Your sword has begun to glow very brightly.`,

  egyptianTomb: `This is a room which looks like an Egyptian tomb.  There is an
ascending staircase in the room as well as doors east and south.
The solid gold coffin used for the burial of Ramses II is here.`,

  maze: `This is part of a maze of twisty little passages, all alike.
Your sword is glowing with a faint blue glow.`,

  darkGrue: `It is pitch black.  You are likely to be eaten by a grue.`,

  templeAltar: `This is the east end of a large temple.  In front of you is what
appears to be an altar.
On the alter is a large black book, open to page 569.
On the two ends of the altar are burning candles.`,
};
