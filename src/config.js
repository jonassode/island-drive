/**
 * Central tunables. Every magic number of the game lives here so the behaviour can be
 * retuned without touching the module logic.
 */

export const WORLD = {
	/** Seed used when no seed is supplied (the app always passes a random one). */
	defaultSeed: 1,
	/** Scale of the island: the terrain fades into the sea around this distance from the
	 * centre. The actual waterline lands near 0.75-0.8 of it. */
	islandRadius: 900,
	/** Side length of the square terrain grid (larger than 2 * islandRadius). */
	size: 2400,
	/** Grid resolution: 384 -> 385 * 385 = 148_225 vertices / 294_912 triangles. */
	segments: 384,
	/** World height of the ocean surface. */
	seaLevel: 0,
	/** Flat height of the island interior (the grassy lowland), before hills are added. */
	baseHeight: 10,
	/** How many random hills are scattered across the island.
	 *
	 * Kept deliberately *sparse*. The hills sum, so a count high enough for their footprints
	 * to blanket the island merges them into a single saturated plateau: a featureless dome
	 * with grass only at the shoreline. At this count the footprints cover roughly half of
	 * the land, which leaves real lowland between genuinely separate hills. */
	hillCount: 40,
	/** Hill footprint radius range. Against `islandRadius` these read as individual hills
	 * rather than as terrain-wide bulges. */
	hillRadiusMin: 70,
	hillRadiusMax: 180,
	/** Hill height range. A hill never grows taller than `hillMaxGrade * radius`, so its
	 * slopes stay drivable. */
	hillHeightMin: 18,
	hillHeightMax: 70,
	hillMaxGrade: 0.45,
	/** Spike guard for the summed hills: only a freak pile-up of overlapping hills can ever
	 * reach this, and it saturates rather than stacking into an unclimbable spire. It must
	 * stay well clear of the height the scattered hills actually reach, or it flattens the
	 * hilltops into the plateau it exists to prevent. */
	hillHeightCap: 130,
	/** Small scale surface detail added on top of the hills.
	 *
	 * Measured: at a 42 u/s top speed a 5 u / 0.006 amplitude-and-scale detail set adds
	 * ~12 u/s^2 of ground curvature, which is right at the launch threshold — the car then
	 * hops on *noise* instead of on hills, spending up to 44% of a full throttle run in the
	 * air. Softening and lengthening it (measured across six seeds) drops that to ~31%, so
	 * what launches the car is a hill crest and nothing else. */
	detailAmplitude: 3.5,
	detailScale: 0.0045,
	detailOctaves: 3,
	/** How far the terrain is pushed below sea level outside of the island. */
	edgeDrop: 40,
	/** Radial falloff: full height until `falloffInner * islandRadius`, sea at `islandRadius`. */
	falloffInner: 0.62,
	falloffOuter: 1,
	/** Land must be this far above sea level before the car is allowed on it. */
	shoreClearance: 0.6,
	/** Preferred spawn height above sea level, so the car starts comfortably inland. */
	spawnMinHeight: 8,
	/** Visual water plane height (a hair above sea level to avoid z-fighting). */
	waterLevel: 0.05,
	/** Depth of the sea floor plane, kept below the terrain's submerged rim. */
	seabedLevel: - 44,
	/** Resolution / extent of the ocean plane. */
	waterSegments: 192,
	waterSize: 7000,
	/** Largest seed we generate (32 bit integers keep the PRNG well behaved). */
	maxSeed: 2147483647,
};

export const ISLAND = {
	/** Height bands used for the vertex colouring. Each value is where one colour starts
	 * blending into the next: sand -> grass -> rock -> snow.
	 *
	 * Tuned against this world's measured height distribution: the grassy lowland sits at
	 * ~10 u, the median land vertex is ~14 u, the hills reach ~50-75 u. So grass owns the
	 * bulk of the island, rock covers the hillsides, and snow is left for the hilltops
	 * (the top ~10% of the land). `tests/heightfield.test.js` asserts those proportions. */
	sandHeight: 4,
	grassHeight: 30,
	snowHeight: 52,
	/** Width of the smooth transition between two bands. */
	blend: 3.5,
	/** Strength of the per-vertex colour variation that stops the surface looking flat. */
	colorVariation: 0.045,
};

export const CAR = {
	/** Forward speed cap, in world units per second (42 u/s ~= 151 km/h). */
	maxSpeed: 42,
	/** Reverse speed cap. */
	maxReverse: 12,
	/** Engine acceleration, in u/s^2. */
	accel: 14,
	/** Braking deceleration, in u/s^2. */
	brake: 30,
	/** Rolling resistance / engine braking applied when coasting, in u/s^2. */
	drag: 4,
	/** Maximum front wheel steering angle, in radians. */
	maxSteer: 0.5,
	/** How fast the steering angle approaches its target, in radians / second. */
	steerRate: 3.2,
	/** Distance between the front and rear axles, in world units. */
	wheelBase: 2.6,
	/** Wheel radius, used to roll the wheels at the correct rate. */
	wheelRadius: 0.36,
	/** How far the chassis floats above the sampled terrain height. The wheels are modelled
	 * with their contact patch at the car's origin, so this stays near zero. */
	rideHeight: 0.02,
	/** Gravity for the slope acceleration term while the wheels are on the ground. */
	gravity: 9.81,
	/** Gravity while airborne. Much stronger than real gravity: it keeps jumps snappy
	 * instead of floaty, which is what an arcade car wants. Measured on the same six-seed
	 * sweep as `launchGravity`: at 34 the car floated for up to 96 frames (1.6 s) per jump,
	 * at this value the longest flight is 51 frames (0.85 s) and every run ends with the car
	 * settled back on its wheels. */
	airGravity: 60,
	/** Fraction of the speed kept when landing. */
	landingDamping: 0.94,
	/** Steepest the body may ever be tilted away from horizontal, in radians (~60 deg).
	 *
	 * A rollover guard, not a limit on the hills. Measured over four seeds, the steepest
	 * drivable ground on these islands is ~52 deg (see `hillMaxGrade` and the detail noise),
	 * so this has to stay comfortably above that: at the old 35 deg the cap engaged on ~100%
	 * of the frames the car spent on ground steeper than 35 deg, and the body was left propped
	 * up at a compromise angle that matched neither the hill nor the horizon. At this value it
	 * is inert on all four of those seeds -- 0% of ~62,000 samples -- and only a cliff or a
	 * freak fit can ever reach it. */
	maxTilt: 1.05,
	/** How far the body may lean away from the ground *under it*, in radians (~26 deg).
	 *
	 * Measured against the terrain's own normal, so it never fights an honest hillside -- only
	 * a fit that genuinely disagrees with the landscape, which means a cliff edge, a rock or a
	 * bump narrower than the wheelbase. This is what stops those from rolling the car over; it
	 * is deliberately loose, since the wheels already average the ground over 2.8 x 2 u, and on
	 * the same four seeds it fired on 0% of ~62,000 samples. When it does fire it moves the
	 * body *towards* the ground under it, never away from it. */
	maxTiltDeviation: 0.45,
	/** How quickly the tilt returns to level while airborne (per second). */
	airLevelRate: 2.5,
	/** How far each wheel may extend or compress independently, so a rigid body can still
	 * keep its wheels on bumpy ground (a visual suspension; no effect on the physics). */
	suspensionTravel: 0.3,
	/** Steering authority is reduced with speed; larger = more reduction. */
	steerFalloff: 0.012,
	/** Water: how quickly the sea drags the car to a halt. */
	waterDrag: 2.4,
	/** Seconds the car flounders in the water before it is respawned. */
	waterRespawnDelay: 0.9,
	/** Trees break above this speed; below it they stop the car. */
	breakSpeedKmh: 50,
	/** Collision radii, in world units. */
	treeRadius: 0.7,
	carRadius: 1.15,
	/** Fraction of the speed kept after smashing through a tree. */
	breakSlowdown: 0.82,
	/** Speed kept (negated) when the car is stopped by something solid. */
	blockBounce: - 0.12,
	/** Speed the car must be doing (u/s) before a crest can launch it: 30 u/s is about
	 * 108 km/h, so the car only flies when it is genuinely being driven fast. */
	launchMinSpeed: 30,
	/** The ground must fall away faster than this (u/s^2) for the car to leave it.
	 *
	 * Picked from a six-seed sweep of full throttle runs rather than by eye, and the sweep
	 * is worth explaining: raising this alone barely lowers the airborne share, because the
	 * long flights come from a crest that launches the car onto a long *descent*, not from a
	 * bigger jump. What raising it does do is thin out the launches, and past ~24 the
	 * feature goes inert on some islands — seed 99 never left the ground at all at 34. At
	 * this value every one of the six seeds launches the car 10-24 times a minute, and the
	 * longest flight is under a second. */
	launchGravity: 20,
	/** Cap on the launch velocity, so a freak crest cannot fire the car into orbit. The
	 * measured climb rates stay below this, so it is a pure safety net. */
	launchMaxSpeed: 8,
	/** Landing above this impact speed counts as a hard landing and scrubs speed. */
	landingImpactSpeed: 4,
	/** Steering authority while airborne (1 = as much as on the ground). */
	airSteerAuthority: 0.25,
	/** How far the car sinks into the water, in world units. */
	waterSink: 0.7,
};

export const MULTIPLAYER = {
	/** Simulation frequency of the server, and of the fixed step the client predicts at.
	 *
	 * Both sides must use the *same* step for client side prediction to reproduce the
	 * server's result exactly, which is why the client no longer simulates at the frame
	 * rate: it accumulates real time and steps this fixed amount. */
	tickRate: 60,
	/** How often the server broadcasts a snapshot of every car, in Hz. */
	snapshotRate: 20,
	/** How far behind the newest snapshot remote cars are drawn, in milliseconds.
	 *
	 * Received snapshots are buffered and played back this much later, so there are always
	 * two snapshots to interpolate between even when one arrival is delayed. */
	interpDelayMs: 120,
	/** Client ticks whose inputs are batched into one message, and the hard cap on how many
	 * an incoming message may carry (a longer burst is truncated rather than applied at once). */
	inputBatch: 3,
	maxInputsPerMessage: 8,
	/** Predicted ticks that may be kept for replay. Beyond this the client stops predicting
	 * and simply follows the server, instead of replaying hundreds of steps every snapshot. */
	replayMaxTicks: 120,
	/** Distance between the predicted car and the corrected one that snaps instead of being
	 * smoothed away, in world units. */
	snapDistance: 4,
	/** How quickly a correction is smoothed out, per second (exponential decay). */
	errorDecay: 8,
	/** Players per room. Also the size of the car colour palette, so every player in a room
	 * can hold a distinct colour. */
	maxPlayers: 8,
	/** Spawn slots are laid out on rings of this radius, at the golden angle, up to
	 * `spawnMaxRadius` from the island's own spawn point. */
	spawnRingRadius: 6,
	spawnMaxRadius: 30,
	/** Default room. A room exists only while somebody is in it; nothing is persisted. */
	room: 'island',
	/** Longest accepted display name, in characters. */
	nameMaxLength: 16,
	/** Car paints handed out at random, one per player per room. Chosen to stay apart in hue
	 * *and* in luminance, so they are still telling apart at a distance and in shadow. */
	colors: [
		0xd93b2b, // red (the single player paint)
		0x2f6fd0, // blue
		0xf2c230, // yellow
		0x36a852, // green
		0xe8762b, // orange
		0x8a4fd0, // purple
		0x2fc4d0, // cyan
		0xe8eef5, // white
	],
	/** Client: how long a snapshot stream may go quiet before the link is treated as lost,
	 * and the reconnect backoff bounds, in milliseconds. */
	staleMs: 3000,
	reconnectMinMs: 500,
	reconnectMaxMs: 8000,
	/** Server: ping period, and how long a socket may stay silent before it is dropped. */
	heartbeatMs: 5000,
	heartbeatTimeoutMs: 15000,
	/** Server: the path the game socket lives on, so it never collides with Vite's own HMR
	 * socket, and the cap on simultaneous rooms (each one holds an island in memory). */
	path: '/ws',
	maxRooms: 64,
};

export const CAMERA = {
	fov: 60,
	near: 0.5,
	far: 4500,
	/** Distance behind the car. */
	distance: 9.5,
	/** Height above the car. */
	height: 4,
	/** How far ahead of the car the camera looks. */
	lookAhead: 4,
	/** Height of the look-at point above the car. */
	lookHeight: 1.4,
	/** Damping constant of the follow motion (larger = snappier). */
	damp: 6,
	/** Minimum clearance between the camera and the terrain. */
	groundClearance: 1.2,
};

export const WATER = {
	/** Sea floor plane size, as a fraction of the water surface plane. Kept slightly
	 * smaller so the opaque floor can never be seen bare at the horizon. */
	seabedScale: 0.9,
	/** Wave trains. Each is a sine wave: `amplitude` in world units, `wavelength` also in
	 * world units, `speed` is angular frequency in radians/second, and (dirX, dirZ) is the
	 * (unnormalized) direction it travels in. */
	waves: [
		{ amplitude: 1.4, wavelength: 420, speed: 1.1, dirX: 1, dirZ: 0.15 },
		{ amplitude: 0.9, wavelength: 260, speed: 2.2, dirX: 0.2, dirZ: 1 },
		{ amplitude: 0.5, wavelength: 150, speed: 3.4, dirX: 1, dirZ: 1 },
	],
};

export const COLORS = {
	fog: 0xa8c8e8,
	water: 0x1f6fa8,
	/** Sea floor, seen through the translucent water surface. */
	seabed: 0x14405f,
	sand: 0xd8c48f,
	grass: 0x4f8f3a,
	rock: 0x7d7568,
	snow: 0xf1f5f9,
	carPaint: 0xd93b2b,
	carTrim: 0x22262c,
	carGlass: 0x1a2a38,
	wheel: 0x131519,
	hub: 0xb9c2cc,
	trunk: 0x6b4a2f,
	foliage: 0x2f6b33,
	rockProp: 0x8a8f96,
	/** Dirt path: the trodden centre of the track, and the darker, caked earth at its edges. */
	dirt: 0x8d6b45,
	dirtDark: 0x63482c,
};

export const SKY = {
	/** Preetham sky parameters (see three/addons/objects/Sky.js). */
	turbidity: 3,
	rayleigh: 2.2,
	mieCoefficient: 0.005,
	mieDirectionalG: 0.8,
	/** Sky dome scale; the shader writes to the far plane, we only need coverage. */
	scale: 10000,
	/** Sun elevation / azimuth in degrees. */
	elevation: 40,
	azimuth: 115,
	/** Physically correct lighting: a value around 3 matches a bright sun. */
	sunIntensity: 3.2,
	hemiIntensity: 0.25,
	/** How strongly the baked sky lights the scene (image based lighting). Kept low: the
	 * Preetham sky is bright, and too much of it desaturates everything towards white. */
	environmentIntensity: 0.2,
	/** Distance of the directional light from the car; only the direction is meaningful,
	 * the position is moved with the car so the shadow frustum can stay tight. */
	sunDistance: 700,
	/** Half extent of the shadow frustum, which follows the car. A 1900 unit wide world
	 * cannot fit into one shadow map, so only the area around the car is shadowed. */
	shadowExtent: 110,
	shadowMapSize: 2048,
	/** Distance at which the haze starts and fully hides the horizon. */
	fogNear: 700,
	fogFar: 2400,
};

export const PROPS = {
	/** How many trees and rocks are scattered across the island. */
	trees: 2600,
	rocks: 320,
	/** Trees grow in clumps: this many clumps, each holding this many trees. */
	clusters: 170,
	clusterSizeMin: 6,
	clusterSizeMax: 26,
	clusterRadiusMin: 25,
	clusterRadiusMax: 70,
	/** Props are only placed between these radii (fraction of islandRadius). */
	minRadius: 0.04,
	maxRadius: 0.95,
	/** Terrain a prop will accept. Trees stop at the top of the grass band, so they carpet
	 * the lowland and the lower slopes instead of standing on bare rock and snow. */
	minHeight: 3,
	maxHeight: 34,
	maxSlope: 0.85,
	/** Radius around the car's spawn point that is kept free of trees and rocks, so a new
	 * island can never start with the car wedged inside a clump. */
	spawnClearance: 35,
	/** A tree's collision radius, in world units. */
	treeRadius: 0.7,
};

export const PATH = {
	/** Where the loop runs, as a fraction of `WORLD.islandRadius`.
	 *
	 * Measured against the terrain rather than guessed: over 40 seeds and 720 directions,
	 * dry land always reaches at least 0.709 of the radius, and a ring at this value still has
	 * 100 u of land outside it at its worst spot. The wobble and the track width eat into
	 * that, leaving a measured worst case of 72 u. So the path is wrapped around the island's
	 * flank — close enough to read as a path *around* the island, far enough in that it never
	 * touches the beach or the sea the ribbon fades into. */
	radius: 0.6,
	/** The loop is not a circle. Each entry is a sine of `k * angle` — an integer harmonic,
	 * so the curve closes on itself exactly — with a seeded phase and amplitude, and the
	 * islands therefore differ in outline and not just in position. Amplitudes are radial
	 * fractions, and they sum to ~0.05, which is what keeps the loop clear of the water. */
	wobble: [
		{ k: 2, amplitude: 0.028 },
		{ k: 3, amplitude: 0.016 },
		{ k: 5, amplitude: 0.008 },
	],
	/** Width variation along the loop, as harmonics too but normalized shares (they sum to
	 * 1), so the track is a little narrower in places without ever pinching shut. */
	widthWobble: [
		{ k: 3, amplitude: 0.6 },
		{ k: 5, amplitude: 0.4 },
	],
	widthVariation: 0.22,
	/** Half the width of the trodden dirt, in world units: a track ~6 u across. */
	halfWidth: 3,
	/** Outer fraction of the half width that fades into the terrain, so the dirt has no hard
	 * procedural edge. The fade is carried by the vertex alpha (`COLORS.dirt` ->
	 * transparent), which is why the path is drawn with a translucent material.
	 *
	 * Kept short on purpose: the fade is brown blending over green ground at partial alpha,
	 * which reads as grey mush, so a wide one turns the track into an airbrushed smear. At
	 * this value the dirt is solid across its inner 70% and fades over the last 30%. */
	edgeFade: 0.3,
	/** How far above the terrain the ribbon is laid, and how much it is crowned along its
	 * centre. The lift clears the sag of the terrain mesh's linear interpolation (measured
	 * under 0.05 u across the 6.25 u cells) with plenty to spare, so the path never sinks
	 * into the ground it was drawn on. */
	lift: 0.12,
	crown: 0.06,
	/** Stations around the loop and samples across it: 768 x 9 vertices, ~12k triangles, one
	 * draw call. The spacing (~4.9 u along, ~0.75 u across) is finer than the terrain's own
	 * 6.25 u cells, which is what makes the ribbon follow the ground under it. */
	segments: 768,
	crossSegments: 8,
	/** Strength of the per-vertex colour variation that stops the dirt looking painted on. */
	colorVariation: 0.1,
};
