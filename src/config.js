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
	/** Steepest ground tilt the car will adopt, in radians (~35 deg). */
	maxTilt: 0.61,
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
