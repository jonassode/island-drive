/**
 * End-to-end smoke test: drives the real page in headless Chrome via the DevTools
 * protocol and checks the three requirements.
 *
 * No npm dependencies: it uses Node's built in fetch + WebSocket and the Chrome that is
 * already installed on the machine. Usage:
 *
 *   1. serve the game:  npm run preview   (or npm run dev)
 *   2. run:             npm run smoke     (SMOKE_URL / CHROME_PATH override the defaults)
 */

import { spawn } from 'node:child_process';
import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { ISLAND, WORLD } from '../src/config.js';

const URL_BASE = process.env.SMOKE_URL ?? 'http://localhost:4173';
const DEBUG_PORT = Number( process.env.SMOKE_PORT ?? 9333 );
const SCREENSHOT = process.env.SMOKE_SCREENSHOT ?? '/tmp/car-game-smoke.png';
const CAR_SHOT = process.env.SMOKE_CAR_SCREENSHOT ?? '/tmp/car-game-car.png';
const ISLAND_SHOT = process.env.SMOKE_ISLAND_SCREENSHOT ?? '/tmp/car-game-island.png';
const PROFILE = '/tmp/car-game-chrome-profile';

const CHROME_CANDIDATES = [
	process.env.CHROME_PATH,
	'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
	'/Applications/Chromium.app/Contents/MacOS/Chromium',
	'/usr/bin/google-chrome',
	'/usr/bin/chromium',
	'/usr/bin/chromium-browser',
].filter( Boolean );

const failures = [];
const notes = [];
/** Console errors seen in the page, so a boot failure can report them. */
const pageErrors = [];

/**
 * Records a check result.
 *
 * @param {string} name Check name.
 * @param {boolean} passed Whether it passed.
 * @param {string} [detail] Extra information.
 * @returns {void}
 */
function check( name, passed, detail = '' ) {

	const line = `${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`;
	( passed ? notes : failures ).push( line );
	console.log( line );

}

/** Minimal CDP client over the DevTools websocket. */
class Devtools {

	constructor( socket ) {

		this.socket = socket;
		this.nextId = 1;
		this.pending = new Map();
		this.listeners = new Map();

		socket.addEventListener( 'message', ( event ) => {

			const message = JSON.parse( event.data );

			if ( message.id !== undefined ) {

				const entry = this.pending.get( message.id );
				if ( entry === undefined ) return;

				this.pending.delete( message.id );
				if ( message.error ) entry.reject( new Error( JSON.stringify( message.error ) ) );
				else entry.resolve( message.result );

				return;

			}

			for ( const listener of this.listeners.get( message.method ) ?? [] ) {

				listener( message.params );

			}

		} );

	}

	/**
	 * Connects to a websocket debugger URL.
	 *
	 * @param {string} url Debugger URL.
	 * @returns {Promise<Devtools>} The client.
	 */
	static connect( url ) {

		return new Promise( ( resolve, reject ) => {

			const socket = new WebSocket( url );
			socket.addEventListener( 'open', () => resolve( new Devtools( socket ) ) );
			socket.addEventListener( 'error', () => reject( new Error( 'devtools socket failed' ) ) );

		} );

	}

	send( method, params = {} ) {

		const id = this.nextId ++;

		return new Promise( ( resolve, reject ) => {

			this.pending.set( id, { resolve, reject } );
			this.socket.send( JSON.stringify( { id, method, params } ) );

		} );

	}

	on( method, listener ) {

		const list = this.listeners.get( method ) ?? [];
		list.push( listener );
		this.listeners.set( method, list );

	}

	async evaluate( expression ) {

		const result = await this.send( 'Runtime.evaluate', {
			expression,
			returnByValue: true,
			awaitPromise: true,
		} );

		if ( result.exceptionDetails ) {

			throw new Error( result.exceptionDetails.exception?.description ?? 'evaluation failed' );

		}

		return result.result.value;

	}

}

/**
 * Waits until the DevTools HTTP endpoint lists a page target.
 *
 * @returns {Promise<object>} The page target.
 */
async function waitForPageTarget() {

	for ( let attempt = 0; attempt < 120; attempt ++ ) {

		try {

			const response = await fetch( `http://127.0.0.1:${DEBUG_PORT}/json/list` );
			const targets = await response.json();
			const page = targets.find( ( target ) => target.type === 'page' );
			if ( page !== undefined ) return page;

		} catch {

			// Chrome is still starting up.

		}

		await sleep( 100 );

	}

	throw new Error( 'Chrome DevTools endpoint never became available' );

}

/**
 * Presses or releases a key through the input domain, exactly like a real user would.
 *
 * @param {Devtools} devtools Client.
 * @param {'ArrowUp'|'ArrowDown'|'ArrowLeft'|'ArrowRight'} code Key code.
 * @param {'rawKeyDown'|'keyUp'} type Event type.
 * @returns {Promise<void>} Resolves once dispatched.
 */
async function dispatchKey( devtools, code, type ) {

	const virtualKey = { ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39 }[ code ];

	await devtools.send( 'Input.dispatchKeyEvent', {
		type,
		code,
		key: code,
		windowsVirtualKeyCode: virtualKey,
		nativeVirtualKeyCode: virtualKey,
	} );

}

/** Samples the terrain on a grid so two islands can be compared numerically. */
const SIGNATURE_EXPRESSION = `(() => {
	const field = window.__carGame.field;
	let sum = 0;
	for (let x = -800; x <= 800; x += 100) {
		for (let z = -800; z <= 800; z += 100) sum += field.heightAt(x, z);
	}
	return Math.round(sum * 100) / 100;
})()`;

/**
 * Polls until the page has booted the game.
 *
 * @param {Devtools} devtools Client.
 * @returns {Promise<void>} Resolves when `window.__carGame` exists.
 */
async function waitForGame( devtools ) {

	for ( let attempt = 0; attempt < 100; attempt ++ ) {

		try {

			const ready = await devtools.evaluate( 'typeof window.__carGame !== "undefined"' );
			if ( ready === true ) return;

		} catch {

			// The execution context is replaced while navigating.

		}

		await sleep( 100 );

	}

	throw new Error( `the game never booted in the page: ${pageErrors.join( ' | ' ) || 'no console output'}` );

}

/**
 * Navigates to a URL and waits for the game to be ready.
 *
 * @param {Devtools} devtools Client.
 * @param {string} url URL to open.
 * @returns {Promise<void>} Resolves once the game booted and a few frames ran.
 */
async function open( devtools, url ) {

	await devtools.send( 'Page.navigate', { url } );
	await waitForGame( devtools );
	await sleep( 700 );

}

async function main() {

	const chromePath = CHROME_CANDIDATES.find( ( candidate ) => existsSync( candidate ) );

	if ( chromePath === undefined ) {

		console.log( 'SKIP  no Chrome found; set CHROME_PATH to run the smoke test' );
		return;

	}

	mkdirSync( PROFILE, { recursive: true } );

	const chrome = spawn( chromePath, [
		'--headless=new',
		`--remote-debugging-port=${DEBUG_PORT}`,
		`--user-data-dir=${PROFILE}`,
		'--no-first-run',
		'--no-default-browser-check',
		'--disable-extensions',
		'--disable-background-networking',
		'--hide-scrollbars',
		'--mute-audio',
		'--window-size=1280,800',
		'--enable-unsafe-swiftshader', // software WebGL fallback when there is no GPU
		'about:blank',
	], { stdio: 'ignore' } );

	let devtools = null;

	try {

		const target = await waitForPageTarget();
		devtools = await Devtools.connect( target.webSocketDebuggerUrl );

		const consoleErrors = pageErrors;

		await devtools.send( 'Runtime.enable' );
		await devtools.send( 'Log.enable' );
		await devtools.send( 'Page.enable' );

		devtools.on( 'Runtime.exceptionThrown', ( params ) => {

			consoleErrors.push( params.exceptionDetails?.exception?.description ?? 'exception' );

		} );

		devtools.on( 'Runtime.consoleAPICalled', ( params ) => {

			if ( params.type !== 'error' ) return;

			consoleErrors.push( params.args.map( ( arg ) => arg.value ?? arg.description ?? '' ).join( ' ' ) );

		} );

		devtools.on( 'Log.entryAdded', ( params ) => {

			if ( params.entry.level === 'error' ) {

				consoleErrors.push( `${params.entry.text} (${params.entry.url ?? 'no url'})` );

			}

		} );

		// ---- requirement 1: a brand new island on every load -------------------------
		await open( devtools, `${URL_BASE}/?seed=1` );
		const firstSignature = await devtools.evaluate( SIGNATURE_EXPRESSION );
		const firstSeed = await devtools.evaluate( 'window.__carGame.field.seed' );

		await open( devtools, `${URL_BASE}/?seed=2` );
		const secondSignature = await devtools.evaluate( SIGNATURE_EXPRESSION );

		check( 'loads without console errors', consoleErrors.length === 0, consoleErrors.join( ' | ' ) );
		check( 'honours the seed from the URL', firstSeed === 1, `seed=${firstSeed}` );
		check( 'a different seed generates a different island', firstSignature !== secondSignature,
			`${firstSignature} vs ${secondSignature}` );

		const scene = await devtools.evaluate( `(() => {
			const game = window.__carGame;
			const canvas = document.getElementById( 'game' );
			return {
				width: canvas.width,
				height: canvas.height,
				drawCalls: game.renderer.info.render.calls,
				triangles: game.renderer.info.render.triangles,
				islandCenter: game.field.heightAt( 0, 0 ),
				waterLevel: game.field.waterLevel,
			};
		})()` );

		check( 'the canvas fills the viewport', scene.width > 800 && scene.height > 400,
			`${scene.width}x${scene.height}` );
		check( 'the centre of the island is above the waterline', scene.islandCenter > scene.waterLevel,
			`h=${scene.islandCenter.toFixed( 2 )}` );
		check( 'geometry is actually being rendered', scene.drawCalls > 5 && scene.triangles > 10000,
			`${scene.drawCalls} draw calls, ${scene.triangles} triangles` );

		// ---- requirement 2: a car is loaded onto the island --------------------------
		const spawned = await devtools.evaluate( `(() => {
			const game = window.__carGame;
			return {
				wheels: game.car.wheels.length,
				parts: game.car.chassis.children.length,
				y: game.car.group.position.y,
				onLand: game.field.isLand( game.state.x, game.state.z ),
				terrain: game.field.heightAt( game.state.x, game.state.z ),
			};
		})()` );

		check( 'the car exists with four wheels and body parts',
			spawned.wheels === 4 && spawned.parts > 4, `${spawned.wheels} wheels, ${spawned.parts} parts` );
		check( 'the car is standing on dry land', spawned.onLand === true,
			`y=${spawned.y.toFixed( 2 )} over terrain ${spawned.terrain.toFixed( 2 )}` );

		// The car must rest on the *rendered* terrain mesh and not float above it. This is
		// the check that ties the visible geometry to the physics: the mesh is generated
		// from the same height field the car samples, so a raycast must land right under it.
		await devtools.evaluate( 'window.__carGame.respawnCar()' );
		await sleep( 200 );

		const contact = await devtools.evaluate( `(() => {
			const game = window.__carGame;
			return {
				carY: game.car.group.position.y,
				mesh: game.probeGround(),
				terrain: game.field.heightAt( game.state.x, game.state.z ),
				rearLeft: game.probeGround( - 0.98, - 1.4 ),
				frontRight: game.probeGround( 0.98, 1.4 ),
			};
		})()` );

		check( 'the car rests on the rendered terrain mesh',
			contact.mesh !== null && Math.abs( contact.carY - contact.mesh ) <= 0.25,
			`car y=${contact.carY.toFixed( 3 )} vs mesh y=${contact.mesh?.toFixed( 3 )}` );
		check( 'the rendered mesh matches the height field it came from',
			Math.abs( contact.mesh - contact.terrain ) <= 0.8,
			`mesh ${contact.mesh?.toFixed( 3 )} vs field ${contact.terrain.toFixed( 3 )} (linear interpolation across the 6.3 u terrain cells accounts for a little of this)` );
		check( 'terrain is within reach of the wheels',
			contact.rearLeft !== null && contact.frontRight !== null &&
			Math.abs( contact.carY - contact.rearLeft ) < 0.8 &&
			Math.abs( contact.carY - contact.frontRight ) < 0.8,
			`wheels at ${contact.rearLeft?.toFixed( 2 )} / ${contact.frontRight?.toFixed( 2 )}` );

		// The strict version: every wheel's contact patch must be on (or within a few
		// centimetres of) the rendered ground. A rigid car bridging a bump can hang a
		// fraction of a unit in the air, but there must be no systematic float.
		const wheelContact = await devtools.evaluate( `(() => {
			const game = window.__carGame;
			const Vector3 = game.car.group.position.constructor;
			const gaps = game.car.wheels.map( ( wheel ) => {
				const point = wheel.getWorldPosition( new Vector3() );
				const ground = game.probeGround( point.x - game.state.x, point.z - game.state.z );
				return { gap: point.y - 0.36 - ground, ground };
			} );
			return { gaps, carY: game.car.group.position.y };
		})()` );

		const worstGap = Math.max( ...wheelContact.gaps.map( ( entry ) => Math.abs( entry.gap ) ) );
		check( 'no wheel is floating above the ground', worstGap < 0.3,
			`worst wheel gap ${worstGap.toFixed( 3 )} u over ground ${wheelContact.gaps.map( ( g ) => g.ground.toFixed( 2 ) ).join( '/' )}` );

		// ---- the world is big, hilly and wooded --------------------------------------
		const world = await devtools.evaluate( `(() => {
			const field = window.__carGame.field;

			// Walk outwards in 32 directions to measure how far dry land reaches.
			let landExtent = 0;
			for (let i = 0; i < 32; i++) {
				const angle = (i / 32) * Math.PI * 2;
				for (let r = 50; r <= field.radius * 1.1; r += 25) {
					const x = Math.cos(angle) * r;
					const z = Math.sin(angle) * r;
					if (field.heightAt(x, z) <= field.waterLevel) break;
					landExtent = Math.max(landExtent, r);
				}
			}

			// Height distribution over the dry land, so the island can be checked for the
			// saturated-plateau failure mode: hills dense enough to blanket the island sum
			// into one plateau capped at hillHeightCap, which leaves rock and snow covering
			// everything with grass only as a rim at the shoreline.
			const heights = [];
			const sampleStep = field.size / 60;
			for (let x = - field.size / 2; x <= field.size / 2; x += sampleStep) {
				for (let z = - field.size / 2; z <= field.size / 2; z += sampleStep) {
					const height = field.heightAt(x, z);
					if (height > field.seaLevel) heights.push(height);
				}
			}
			heights.sort((a, b) => a - b);
			const shareAbove = (threshold) => heights.filter((h) => h > threshold).length / heights.length;

			return {
				radius: field.radius,
				size: field.size,
				hills: field.hills.length,
				hillQuadrants: new Set(field.hills.map((hill) => (hill.x >= 0 ? 'e' : 'w') + (hill.z >= 0 ? 'n' : 's'))).size,
				medianLandHeight: heights[Math.floor(heights.length / 2)],
				rockShare: shareAbove(${ISLAND.grassHeight}),
				snowShare: shareAbove(${ISLAND.snowHeight}),
				trees: window.__carGame.props.treeCount,
				landExtent,
				drivable: field.isLand(400, 0) && field.isLand(0, 400) && field.isLand(-400, -400),
			};
		})()` );

		check( 'the island is about ten times its old size',
			world.radius >= 800 && world.size >= 2000 && world.landExtent > 600,
			`radius ${world.radius} u, grid ${world.size} u, land reaches ${Math.round( world.landExtent )} u` );
		check( 'hills are scattered across the island instead of piled in the middle',
			world.hills >= 25 && world.hillQuadrants === 4,
			`${world.hills} hills across ${world.hillQuadrants} quadrants` );
		check( 'the island is grassy lowland with hills on it, not one saturated plateau',
			world.medianLandHeight < WORLD.baseHeight + 20 && world.rockShare > 0.05 &&
			world.rockShare < 0.45 && world.snowShare < 0.2,
			`median land height ${world.medianLandHeight.toFixed( 1 )} u, rock ${( world.rockShare * 100 ).toFixed( 0 )}%, snow ${( world.snowShare * 100 ).toFixed( 0 )}%` );
		check( 'the island is wooded', world.trees > 1000, `${world.trees} trees` );
		check( 'land is drivable hundreds of units from the centre', world.drivable === true, '' );

		// ---- a fast car flies off the crests -----------------------------------------
		// Stepped manually so this is deterministic: no rendering, no timing luck. The seeds
		// are loaded explicitly because the page generates a random island by default, which
		// made this check pass or fail depending on which island a run happened to get. Seeds
		// 7 and 99 are the extremes found by the headless sweep behind CAR.launchGravity:
		// the longest glides, and the island on which the car never flew at all until the
		// threshold was lowered.
		const flightSeeds = [ 1, 7, 99 ];
		const flights = [];

		for ( const seed of flightSeeds ) {

			await open( devtools, `${URL_BASE}/?seed=${seed}` );

			const run = await devtools.evaluate( `(() => {
			const game = window.__carGame;
			game.respawnCar();
			const throttle = { up: true, down: false, left: false, right: false };

			let launches = 0;
			let maxClearance = 0;
			let longestFlight = 0;
			let airborneFrames = 0;
			let current = 0;
			let frames = 0;
			let topSpeed = 0;

			while (frames < 3600) {
				game.step(1 / 60, throttle);

				// Leave the island and the run is over: time floating would dilute the numbers.
				if (game.state.inWater || game.field.isLand(game.state.x, game.state.z) === false) break;

				frames++;
				const clearance = game.state.y - game.field.heightAt(game.state.x, game.state.z);
				topSpeed = Math.max(topSpeed, game.state.speed);

				if (game.state.airborne) {
					airborneFrames++;
					current++;
					maxClearance = Math.max(maxClearance, clearance);
				} else {
					longestFlight = Math.max(longestFlight, current);
					current = 0;
				}

				for (const event of game.state.events) {
					if (event.type === 'launch') launches++;
				}
			}

			// Coast for three seconds, so a car that flew over a crest has to come back down.
			for (let i = 0; i < 180; i++) {
				game.step(1 / 60, { up: false, down: false, left: false, right: false });
			}

			return {
				launches,
				maxClearance,
				longestFlight: Math.max(longestFlight, current),
				airborneShare: airborneFrames / Math.max(1, frames),
				frames,
				topSpeed,
				grounded: game.state.airborne === false,
			};
		})()` );

			flights.push( { seed, ...run } );

		}

		const minLaunches = Math.min( ...flights.map( ( f ) => f.launches ) );
		const maxLaunches = Math.max( ...flights.map( ( f ) => f.launches ) );
		const peakClearance = Math.max( ...flights.map( ( f ) => f.maxClearance ) );
		const worstFlight = Math.max( ...flights.map( ( f ) => f.longestFlight ) );
		const worstAirborne = Math.max( ...flights.map( ( f ) => f.airborneShare ) );
		const allGrounded = flights.every( ( f ) => f.grounded );

		check( 'driving fast launches the car off hill crests on every island',
			minLaunches > 2 && peakClearance > 0.2,
			`launches ${minLaunches}-${maxLaunches} on seeds ${flightSeeds.join( ', ' )}, peak clearance ${peakClearance.toFixed( 2 )} u, longest flight ${worstFlight} frames` );
		check( 'flights end and the car comes back down onto its wheels',
			worstFlight < 80 && worstAirborne < 0.4 && allGrounded,
			`longest flight ${worstFlight} frames, worst airborne share ${( worstAirborne * 100 ).toFixed( 1 )}%, grounded everywhere=${allGrounded}` );

		// ---- trees break above 50 km/h -------------------------------------------------
		const treeRun = await devtools.evaluate( `(() => {
			const game = window.__carGame;
			game.respawnCar();
			const state = game.state;

			// Find a living tree a reasonable distance away and line the car up on it.
			let target = null;
			for (const tree of game.props.trees) {
				if (!tree.alive) continue;
				const distance = Math.hypot(tree.x - state.x, tree.z - state.z);
				if (distance < 40 || distance > 400) continue;
				if (target === null || distance < target.distance) target = { tree, distance };
			}

			if (target === null) return { error: 'no tree within range' };

			const heading = Math.atan2(target.tree.x - state.x, target.tree.z - state.z);
			const approach = 22;
			state.x = target.tree.x - Math.sin(heading) * approach;
			state.z = target.tree.z - Math.cos(heading) * approach;
			state.y = game.field.heightAt(state.x, state.z);
			state.groundY = state.y;
			state.heading = heading;

			let broke = false;

			for (let i = 0; i < 180; i++) {
				// Hold a speed above the 50 km/h threshold, whatever the slope does.
				state.speed = Math.max(state.speed, 24);
				game.step(1 / 60, { up: true, down: false, left: false, right: false });
				if (game.state.events.some((event) => event.type === 'treeBreak')) broke = true;
			}

			return {
				broke,
				alive: target.tree.alive,
				debris: game.debris.activeCount,
				distance: target.distance,
			};
		})()` );

		check( 'driving into a tree above 50 km/h smashes it',
			treeRun.error === undefined && treeRun.broke === true && treeRun.alive === false,
			treeRun.error ?? `tree at ${Math.round( treeRun.distance ?? 0 )} u, alive=${treeRun.alive}` );
		check( 'smashing a tree throws debris', ( treeRun.debris ?? 0 ) > 0,
			`${treeRun.debris ?? 0} shards in flight` );

		// ---- driving into the sea respawns the car ------------------------------------
		const seaRun = await devtools.evaluate( `(() => {
			const game = window.__carGame;
			game.respawnCar();
			const state = game.state;

			// Drop the car in the middle of the ocean.
			state.x = game.field.radius * 1.3;
			state.z = 0;
			state.speed = 0;

			let sawWater = false;
			let sawRespawn = false;

			for (let i = 0; i < 300; i++) {
				game.step(1 / 60, { up: false, down: false, left: false, right: false });
				if (game.state.inWater) sawWater = true;
				if (game.state.events.some((event) => event.type === 'respawn')) sawRespawn = true;
			}

			return {
				sawWater,
				sawRespawn,
				inWater: state.inWater,
				onLand: game.field.isLand(state.x, state.z),
				depth: game.field.waterDepthAt(game.field.radius * 1.3, 0),
			};
		})()` );

		check( 'the sea is detected when the car drives into it',
			seaRun.sawWater === true && seaRun.depth > 5, `water depth ${seaRun.depth.toFixed( 1 )} u` );
		check( 'being in the water respawns the car on dry land',
			seaRun.sawRespawn === true && seaRun.inWater === false && seaRun.onLand === true, '' );

		// ---- requirement 3: arrow keys drive the car ---------------------------------
		// The car must be able to pull away from where it spawns: a spawn wedged inside a tree
		// clump would leave a fresh island unplayable.
		const escape = await devtools.evaluate( `(() => {
			const game = window.__carGame;
			game.respawnCar();
			const state = game.state;
			const startX = state.x;
			const startZ = state.z;
			let blocked = 0;

			for (let i = 0; i < 300; i++) {
				game.step(1 / 60, { up: true, down: false, left: false, right: false });
				if (game.state.blocked) blocked++;
			}

			return {
				travelled: Math.hypot(state.x - startX, state.z - startZ),
				speed: state.speed,
				blocked,
			};
		})()` );

		check( 'the car can drive away from its spawn', escape.travelled > 30 && escape.speed > 5,
			`travelled ${escape.travelled.toFixed( 1 )} u in 5 s, ended at ${escape.speed.toFixed( 1 )} u/s, blocked on ${escape.blocked} frames` );

		await devtools.evaluate( 'window.__carGame.respawnCar()' );
		await sleep( 200 );

		const before = await devtools.evaluate(
			'( { x: window.__carGame.state.x, z: window.__carGame.state.z, heading: window.__carGame.state.heading } )' );

		await dispatchKey( devtools, 'ArrowUp', 'rawKeyDown' );
		await sleep( 1200 );
		const driving = await devtools.evaluate(
			'( { speed: window.__carGame.state.speed, x: window.__carGame.state.x, z: window.__carGame.state.z } )' );
		await dispatchKey( devtools, 'ArrowUp', 'keyUp' );

		const travelled = Math.hypot( driving.x - before.x, driving.z - before.z );
		check( 'ArrowUp accelerates and moves the car', driving.speed > 1 && travelled > 1,
			`speed=${driving.speed.toFixed( 2 )} u/s after travelling ${travelled.toFixed( 2 )} u` );

		await dispatchKey( devtools, 'ArrowUp', 'rawKeyDown' );
		await dispatchKey( devtools, 'ArrowLeft', 'rawKeyDown' );
		await sleep( 900 );
		const turningLeft = await devtools.evaluate( 'window.__carGame.state.heading' );
		await dispatchKey( devtools, 'ArrowLeft', 'keyUp' );

		await dispatchKey( devtools, 'ArrowRight', 'rawKeyDown' );
		await sleep( 1500 );
		const turningRight = await devtools.evaluate( 'window.__carGame.state.heading' );
		await dispatchKey( devtools, 'ArrowRight', 'keyUp' );
		await dispatchKey( devtools, 'ArrowUp', 'keyUp' );

		// Pedal test from the flat spawn point: get up to speed in a straight line, then
		// brake and reverse. Starting from a known flat spot keeps this repeatable.
		await devtools.evaluate( 'window.__carGame.respawnCar()' );
		await dispatchKey( devtools, 'ArrowUp', 'rawKeyDown' );
		await sleep( 1000 );
		const fastSpeed = await devtools.evaluate( 'window.__carGame.state.speed' );
		await dispatchKey( devtools, 'ArrowUp', 'keyUp' );

		await dispatchKey( devtools, 'ArrowDown', 'rawKeyDown' );
		await sleep( 900 );
		const braking = await devtools.evaluate( 'window.__carGame.state.speed' );

		// Reversing can fight gravity on a slope, so sample the whole window and keep the
		// slowest reading.
		let slowest = Infinity;

		for ( let sample = 0; sample < 10; sample ++ ) {

			await sleep( 200 );
			slowest = Math.min( slowest, await devtools.evaluate( 'window.__carGame.state.speed' ) );

		}

		await dispatchKey( devtools, 'ArrowDown', 'keyUp' );

		check( 'ArrowLeft steers left (heading grows)', turningLeft > before.heading,
			`${before.heading.toFixed( 3 )} -> ${turningLeft.toFixed( 3 )}` );
		check( 'ArrowRight steers right (heading shrinks)', turningRight < turningLeft,
			`${turningLeft.toFixed( 3 )} -> ${turningRight.toFixed( 3 )}` );
		check( 'ArrowDown brakes the car', braking < fastSpeed - 5,
			`${fastSpeed.toFixed( 2 )} -> ${braking.toFixed( 2 )} u/s` );
		check( 'ArrowDown reverses once the car has stopped', slowest < - 0.5,
			`slowest speed ${slowest.toFixed( 2 )} u/s` );

		// ---- R regenerates the island -------------------------------------------------
		const beforeR = await devtools.evaluate(
			`( { seed: window.__carGame.field.seed, signature: ${SIGNATURE_EXPRESSION} } )` );
		await devtools.evaluate( 'window.__carGame.regenerateIsland()' );
		await sleep( 500 );
		const afterR = await devtools.evaluate(
			`( { seed: window.__carGame.field.seed, signature: ${SIGNATURE_EXPRESSION}, onLand: window.__carGame.field.isLand( window.__carGame.state.x, window.__carGame.state.z ) } )` );

		check( 'regenerating builds a new island and respawns the car on it',
			afterR.seed !== beforeR.seed && afterR.signature !== beforeR.signature && afterR.onLand === true,
			`seed ${beforeR.seed} -> ${afterR.seed}` );

		// ---- visual artefact -----------------------------------------------------------
		await open( devtools, `${URL_BASE}/?seed=7` );
		await dispatchKey( devtools, 'ArrowUp', 'rawKeyDown' );
		await sleep( 1600 );
		await dispatchKey( devtools, 'ArrowUp', 'keyUp' );

		const shot = await devtools.send( 'Page.captureScreenshot', { format: 'png' } );
		writeFileSync( SCREENSHOT, Buffer.from( shot.data, 'base64' ) );
		console.log( `\nscreenshot: ${SCREENSHOT}` );

		// A static three-quarter close-up of the car, for eyeballing the model itself.
		// The car is put back on its flat spawn point and the animation loop is stopped so
		// the camera stays exactly where it is put.
		await devtools.evaluate( `(() => {
			const game = window.__carGame;
			game.renderer.setAnimationLoop( null );
			game.respawnCar();
			const position = game.car.group.position;
			game.camera.position.set( position.x + 5.5, position.y + 2.2, position.z - 5.5 );
			game.camera.lookAt( position.x, position.y + 0.5, position.z );
			game.renderer.render( game.scene, game.camera );
		})()` );

		const closeup = await devtools.send( 'Page.captureScreenshot', { format: 'png' } );
		writeFileSync( CAR_SHOT, Buffer.from( closeup.data, 'base64' ) );
		console.log( `car close-up: ${CAR_SHOT}` );

		// Whole island from above. At the new scale that means standing well back: the island is
		// roughly 1700 units across while the ocean plane is 7000, so the fog is pushed out
		// rather than removed. Removing it entirely would expose the ocean plane's own edge (and
		// the far plane's clipping of it) as a hard square against the sky; pushing it past the
		// island keeps the silhouette crisp while the far water still fades into a proper
		// horizon, exactly as it does during play.
		await devtools.evaluate( `(() => {
			const game = window.__carGame;
			const original = game.scene.fog;
			game.scene.fog = new original.constructor( original.color, 2000, 4200 );
			game.camera.position.set( 0, 1250, 1050 );
			game.camera.lookAt( 0, 0, 0 );
			game.renderer.render( game.scene, game.camera );
		})()` );

		const overview = await devtools.send( 'Page.captureScreenshot', { format: 'png' } );
		writeFileSync( ISLAND_SHOT, Buffer.from( overview.data, 'base64' ) );
		console.log( `island overview: ${ISLAND_SHOT}` );

	} finally {

		if ( devtools !== null ) devtools.socket.close();
		chrome.kill( 'SIGTERM' );
		await sleep( 300 );
		chrome.kill( 'SIGKILL' );

	}

	console.log( `\n${failures.length === 0 ? 'ALL CHECKS PASSED' : `${failures.length} CHECK(S) FAILED`}` );
	process.exitCode = failures.length === 0 ? 0 : 1;

}

main().catch( ( error ) => {

	console.error( 'smoke test crashed:', error );
	process.exitCode = 1;

} );
