// Takes the pictures of the app for the README and the website, into docs/screenshots:
// each tab of the app in a Mac window, its menu in the menu bar, and what it makes in
// Google Sheets and Airtable. The app's the real thing, run against the stand-ins the
// tests use; the menu bar and the tables are drawn, as they're not the app's to show.
// Run it with: npm run screenshots (it builds the app first), or to look without
// replacing them: npm run screenshots -- <folder>
import { _electron as electron, selectors } from '@playwright/test'
import { promises as fs } from 'fs'
import * as os from 'os'
import * as path from 'path'
import { fileURLToPath } from 'url'
import { fakeAirtable } from '../e2e/fake-airtable.mjs'
import { fakeOAuth } from '../e2e/fake-google.mjs'
import { MetadataCache, cacheFile } from '../core/cache.js'
import { finderSize } from '../core/format.js'
import { mediaValues } from '../core/probe.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
// another folder can be given, to look at a change without touching the committed pictures
const OUT = process.argv[2] ? path.resolve(process.argv[2]) : path.join(ROOT, 'docs', 'screenshots')
const WIDTH = 960
const HEIGHT = 680
const SCALE = 2
const ACCOUNT = 'studio@generativenoise.com'

// a show's worth of content, small as the pictures only need the names
const PROJECT = [
	'01 Brief/Creative brief v2.pdf',
	'02 Design/Storyboard v5.pdf',
	'02 Design/Style frames/Opener frame 01.png',
	'03 Renders/Opener/Opener_v012.mov',
	'03 Renders/Opener/Opener_v013.mov',
	'03 Renders/Walk-on/Walkon_v004.mov',
	'04 Audio/Walk-on mix v2.wav',
	'05 Delivery/Opener/Opener_v013.mov',
	'05 Delivery/Walk-on/Walkon_v004.mov',
	'05 Delivery/Screens/LED Main 7680x1080_v002.mov',
	'05 Delivery/Stills/Backdrop 4K.png'
]

// what ffprobe would find in each, were they real: the files are only their names, so these go
// into the app's media cache, which it reads as it would for files it had looked at before
const video = (codec, width, height, fps, seconds, alpha = false) => ({ streams: [{ codec_type: 'video', codec_name: codec, width, height, r_frame_rate: `${fps}/1`, pix_fmt: alpha ? 'yuva444p12le' : 'yuv422p10le', bit_rate: '400000000' }], format: { duration: String(seconds) } })
const still = (codec, width, height) => ({ streams: [{ codec_type: 'video', codec_name: codec, width, height, pix_fmt: 'rgb24' }], format: { format_long_name: `piped ${codec} sequence` } })
const MEDIA = [
	[/Opener frame/, still('png', 1920, 540)],
	[/Opener_v\d+\.mov$/, video('prores', 3840, 1080, 50, 42.5)],
	[/Walkon_v\d+\.mov$/, video('prores', 1920, 1080, 25, 18, true)],
	[/Walk-on mix/, { streams: [{ codec_type: 'audio', codec_name: 'pcm_s24le', sample_rate: '48000', channels: 2, bit_rate: '2304000' }], format: { duration: '48' } }],
	[/LED Main/, video('hap', 7680, 1080, 50, 120)],
	[/Backdrop 4K/, still('png', 3840, 2160)]
]

async function seedMedia(root) {
	const cache = new MetadataCache(cacheFile([root]))
	await cache.load()
	for(const file of await fs.readdir(root, { recursive: true })) {
		const probe = MEDIA.find(([name]) => name.test(file))?.[1]
		const fullPath = path.join(root, file)
		const stat = await fs.stat(fullPath)
		if(stat.isFile())
			cache.set(fullPath, stat.size, stat.mtime.toISOString(), mediaValues(probe))
	}
	await cache.save()
}

// an editor sets ELECTRON_RUN_AS_NODE, which makes Electron plain Node: it's left out, as
// Windows counts it as set even when it's empty
// eslint-disable-next-line no-unused-vars
const withoutRunAsNode = ({ ELECTRON_RUN_AS_NODE, ...env }) => env

const escape = text => String(text).replace(/[&<>"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char])

// about the size each would be, so the pictures show real sizes: the files are sparse,
// so they take up next to no room, and a change of a few bytes makes a new export
const SIZES = [
	[/\.pdf$/, 2_480_000],
	[/frame 01\.png$/, 6_200_000],
	[/Opener_v\d+\.mov$/, 1_843_200_000],
	[/Walkon_v\d+\.mov$/, 925_400_000],
	[/\.wav$/, 27_648_000],
	[/LED Main/, 2_210_000_000],
	[/Backdrop 4K/, 24_500_000]
]

async function place(root, file, change = 0) {
	const fullPath = path.join(root, file)
	await fs.mkdir(path.dirname(fullPath), { recursive: true })
	await fs.writeFile(fullPath, '')
	await fs.truncate(fullPath, (SIZES.find(([name]) => name.test(file))?.[1] ?? 10_000) + change)
}

async function writeProject(root) {
	for(const file of PROJECT)
		await place(root, file)
}

// a page of our own, drawn in a window of its own, as a picture with see-through edges
async function draw(app, work, name, html, { width, height }) {
	const file = path.join(work, `${name}.html`)
	await fs.writeFile(file, `<!doctype html><meta charset="utf-8"><style>
		* { box-sizing: border-box }
		html, body { margin: 0; background: transparent; font: 13px/1.4 -apple-system, system-ui, 'Segoe UI', sans-serif }
	</style>${html}`)

	const [page] = await Promise.all([
		app.waitForEvent('window'),
		app.evaluate(({ BrowserWindow }, { file, width, height }) => {
			const window = new BrowserWindow({ width, height, useContentSize: true, frame: false, transparent: true, hasShadow: false, show: true })
			window.loadFile(file)
		}, { file, width, height })
	])
	await page.waitForLoadState('load')
	await page.evaluate(() => Promise.all([...document.images].map(image => image.decode())))
	await page.screenshot({ path: path.join(OUT, `${name}.png`), omitBackground: true })
	await page.close()
}

// a Mac window round a picture, with its title bar, traffic lights and shadow
// room for the whole of the shadow, which would otherwise stop in a hard edge
const MARGIN = { side: 110, top: 80, bottom: 150 }
const TITLE_BAR = 28

function macWindow(title, content, width, height) {
	return `<style>
		body { padding: ${MARGIN.top}px ${MARGIN.side}px ${MARGIN.bottom}px }
		.window { width: ${width}px; border-radius: 11px; overflow: hidden; background: #f5f5f7;
			box-shadow: 0 0 0 0.5px rgb(0 0 0 / 0.25), 0 22px 70px rgb(0 0 0 / 0.32), 0 6px 18px rgb(0 0 0 / 0.12) }
		.bar { position: relative; height: ${TITLE_BAR}px; display: flex; align-items: center; justify-content: center;
			background: #ececee; border-bottom: 0.5px solid rgb(0 0 0 / 0.12); font-weight: 600; color: #4d4d52 }
		.lights { position: absolute; left: 13px; top: 8px; display: flex; gap: 8px }
		.lights i { width: 12px; height: 12px; border-radius: 50%; box-shadow: inset 0 0 0 0.5px rgb(0 0 0 / 0.15) }
		.content { width: ${width}px; height: ${height}px; overflow: hidden; position: relative }
		.content > img { display: block; width: 100%; height: 100% }
	</style>
	<div class="window">
		<div class="bar"><div class="lights"><i style="background:#ff5f57"></i><i style="background:#febc2e"></i><i style="background:#28c840"></i></div>${escape(title)}</div>
		<div class="content">${content}</div>
	</div>`
}

const framed = (width, height) => ({
	width: width + MARGIN.side * 2,
	height: height + TITLE_BAR + MARGIN.top + MARGIN.bottom
})

// the folders and files the tables show, with what the tracker found out about them
const ROWS = [
	{ path: '/03 Renders/Opener/Opener_v013.mov', parent: '/03 Renders/Opener', size: 1843200000, modified: '2026-11-21 16:42', duration: 42.5, codec: 'prores', width: 3840, height: 1080, fps: 50, alpha: false, notes: 'Approved by client' },
	{ path: '/03 Renders/Walk-on/Walkon_v004.mov', parent: '/03 Renders/Walk-on', size: 925400000, modified: '2026-11-20 11:08', duration: 18, codec: 'prores', width: 1920, height: 1080, fps: 25, alpha: true, notes: '' },
	{ path: '/04 Audio/Walk-on mix v2.wav', parent: '/04 Audio', size: 9216000, modified: '2026-11-19 09:30', duration: 48, codec: '', width: 0, height: 0, fps: 0, alpha: false, notes: '' },
	{ path: '/05 Delivery/Opener/Opener_v013.mov', parent: '/05 Delivery/Opener', size: 1843200000, modified: '2026-11-21 17:05', duration: 42.5, codec: 'hap', width: 3840, height: 1080, fps: 50, alpha: false, notes: 'On the servers' },
	{ path: '/05 Delivery/Screens/LED Main 7680x1080_v002.mov', parent: '/05 Delivery/Screens', size: 2210000000, modified: '2026-11-22 10:14', duration: 120, codec: 'hap', width: 7680, height: 1080, fps: 50, alpha: false, notes: '' },
	{ path: '/05 Delivery/Stills/Backdrop 4K.png', parent: '/05 Delivery/Stills', size: 24500000, modified: '2026-11-18 14:51', duration: 0, codec: 'png', width: 3840, height: 2160, fps: 0, alpha: true, notes: '' },
	{ path: '/05 Delivery/Walk-on/Walkon_v004.mov', parent: '/05 Delivery/Walk-on', size: 925400000, modified: '2026-11-20 11:40', duration: 18, codec: 'hap', width: 1920, height: 1080, fps: 25, alpha: true, notes: 'Needs a re-render' }
]

const COLUMNS = [
	['_path', 'text', row => row.path],
	['_parent', 'link', row => row.parent],
	['_sizeText', 'text', row => finderSize(row.size)],
	['_mtime', 'date', row => row.modified],
	['_duration', 'number', row => row.duration.toFixed(2)],
	['_videoCodec', 'text', row => row.codec],
	['_videoWidth', 'number', row => row.width],
	['_videoHeight', 'number', row => row.height],
	['_videoFPS', 'number', row => row.fps],
	['_videoAlpha', 'check', row => row.alpha]
]

function sheetsPage(width, height) {
	const letters = 'ABCDEFGHIJKL'
	const widths = [260, 150, 95, 125, 72, 92, 86, 88, 70, 84, 150]
	const cells = row => [...COLUMNS.map(([, type, value]) => {
		const cell = value(row)
		const align = type == 'number' || type == 'date' ? 'right' : type == 'check' ? 'center' : 'left'
		return `<td style="text-align:${align}">${type == 'check' ? `<span class="box${cell ? ' on' : ''}"></span>` : escape(cell)}</td>`
	}), `<td>${escape(row.notes)}</td>`].join('')

	return `<style>
		.sheets { width: ${width}px; height: ${height}px; display: flex; flex-direction: column; background: #f9fbfd; font-family: Arial, sans-serif; color: #1f1f1f }
		.top { display: flex; align-items: center; gap: 10px; padding: 10px 14px 4px; font: 18px 'Google Sans', -apple-system, sans-serif }
		.mark { width: 26px; height: 32px; border-radius: 3px; background: #0f9d58; position: relative }
		.mark::after { content: ''; position: absolute; inset: 11px 6px 7px; border: 2px solid #fff; border-width: 2px 0; box-shadow: inset 0 3px 0 -1px #fff }
		.menus { padding: 0 52px 8px; font: 13px 'Google Sans', -apple-system, sans-serif; color: #444; word-spacing: 12px }
		.grid { flex: 1; overflow: hidden; background: #fff; border-top: 1px solid #c4c7c5 }
		table { border-collapse: collapse; table-layout: fixed; font-size: 12px }
		td, th { height: 21px; padding: 0 5px; border: 1px solid #e1e1e1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis }
		th { background: #f8f9fa; color: #5f6368; font-weight: normal; text-align: center }
		th.row { width: 46px }
		tr.head td { font-weight: bold }
		td.noted { position: relative }
		td.noted::after { content: ''; position: absolute; top: 0; right: 0; border: 4px solid transparent; border-top-color: #e37400; border-right-color: #e37400 }
		.box { display: inline-block; width: 12px; height: 12px; border: 1.5px solid #5f6368; border-radius: 2px; vertical-align: middle }
		.box.on { background: #188038; border-color: #188038 }
		.tabs { display: flex; gap: 2px; padding: 0 0 0 52px; background: #f9fbfd; border-top: 1px solid #c4c7c5; font: 13px 'Google Sans', -apple-system, sans-serif }
		.tabs span { padding: 7px 16px; color: #444 }
		.tabs .on { background: #e1e9f7; color: #0b57d0; font-weight: 600 }
	</style>
	<div class="sheets">
		<div class="top"><span class="mark"></span>Show content</div>
		<div class="menus">File Edit View Insert Format Data Tools Extensions Help</div>
		<div class="grid"><table>
			<colgroup><col style="width:46px">${widths.map(w => `<col style="width:${w}px">`).join('')}</colgroup>
			<tr><th class="row"></th>${widths.map((w, i) => `<th>${letters[i]}</th>`).join('')}</tr>
			<tr class="head"><th>1</th>${COLUMNS.map(([name], i) => `<td${i == 0 ? ' class="noted"' : ''}>${name}</td>`).join('')}<td>Notes</td></tr>
			${ROWS.map((row, i) => `<tr><th>${i + 2}</th>${cells(row)}</tr>`).join('')}
			${Array.from({ length: 14 }, (_, i) => `<tr><th>${ROWS.length + i + 2}</th>${widths.map(() => '<td></td>').join('')}</tr>`).join('')}
		</table></div>
		<div class="tabs"><span>Folders</span><span class="on">Files</span></div>
	</div>`
}

function airtablePage(width, height) {
	const icons = { text: 'A', link: '⇄', number: '#', date: '▦', check: '☑' }
	const widths = [290, 180, 110, 140, 90, 100, 100, 100, 80, 100]
	const cell = (type, value) => {
		if(type == 'link')
			return `<span class="chip">${escape(value)}</span>`
		if(type == 'check')
			return value ? '<span class="tick">✓</span>' : ''
		return escape(value)
	}

	return `<style>
		.airtable { width: ${width}px; height: ${height}px; display: flex; flex-direction: column; background: #fff; color: #1d1f25 }
		.base { display: flex; align-items: center; gap: 10px; height: 52px; padding: 0 16px; background: #0d7f78; color: #fff; font-size: 17px; font-weight: 600 }
		.base i { width: 28px; height: 28px; border-radius: 6px; background: rgb(255 255 255 / 0.25) }
		.tables { display: flex; align-items: flex-end; gap: 2px; height: 34px; padding: 0 10px; background: #0b6c66 }
		.tables span { padding: 7px 14px; color: #fff; border-radius: 4px 4px 0 0 }
		.tables .on { background: #fff; color: #1d1f25; font-weight: 600 }
		.tables small { margin-left: 5px; opacity: 0.6 }
		.views { display: flex; gap: 18px; padding: 9px 16px; border-bottom: 1px solid #e1e2e6; color: #4c5161 }
		.views b { color: #1d1f25 }
		table { border-collapse: collapse; table-layout: fixed; font-size: 13px }
		td, th { height: 33px; padding: 0 8px; border-right: 1px solid #e1e2e6; border-bottom: 1px solid #e1e2e6; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; text-align: left }
		th { background: #f4f6f8; font-weight: 500; color: #333 }
		th small { color: #8a8f99; margin-right: 6px; font-weight: 600 }
		td.n { color: #8a8f99; text-align: center; width: 44px }
		.chip { display: inline-block; padding: 1px 7px; border-radius: 4px; background: #e1effd; color: #10457a; font-size: 12px }
		.tick { color: #20c933; font-weight: 700 }
	</style>
	<div class="airtable">
		<div class="base"><i></i>Show content</div>
		<div class="tables"><span>Folders<small>ⓘ</small></span><span class="on">Files<small>ⓘ</small></span></div>
		<div class="views"><b>▦ Grid view</b><span>Hide fields</span><span>Filter</span><span>Group</span><span>Sort</span></div>
		<table>
			<colgroup><col style="width:44px">${widths.map(w => `<col style="width:${w}px">`).join('')}</colgroup>
			<tr><th></th>${COLUMNS.map(([name, type]) => `<th><small>${icons[type]}</small>${name}</th>`).join('')}</tr>
			${ROWS.map((row, i) => `<tr><td class="n">${i + 1}</td>${COLUMNS.map(([, type, value]) => `<td${type == 'number' ? ' style="text-align:right"' : ''}>${cell(type, value(row))}</td>`).join('')}</tr>`).join('')}
		</table>
	</div>`
}

// the menu bar's own icons, near enough, beside the app's
const WIFI = '<svg viewBox="0 0 20 16" width="20" height="16"><path fill="#fff" d="M10 13.2a1.6 1.6 0 1 1 0 3.2 1.6 1.6 0 0 1 0-3.2zm-4.2-2.6a6 6 0 0 1 8.4 0l-1.3 1.4a4.1 4.1 0 0 0-5.8 0zM2.9 7.7a10.2 10.2 0 0 1 14.2 0l-1.3 1.4a8.3 8.3 0 0 0-11.6 0zM0 4.8a14.3 14.3 0 0 1 20 0l-1.3 1.4a12.4 12.4 0 0 0-17.4 0z"/></svg>'
const BATTERY = '<svg viewBox="0 0 28 13" width="28" height="13"><rect x="0.5" y="0.5" width="24" height="12" rx="3.5" fill="none" stroke="#fff" stroke-opacity="0.6"/><rect x="2" y="2" width="17" height="9" rx="2" fill="#fff"/><path d="M26 4.5v4a2 2 0 0 0 0-4z" fill="#fff" fill-opacity="0.6"/></svg>'

async function menuBarPage(width, height) {
	const tray = (await fs.readFile(path.join(ROOT, 'build', 'tray.svg'), 'utf8')).replace(/<title>.*?<\/title>/s, '')
	const items = [
		['Watching - last scanned at 4:32 pm', 'off'],
		['-'],
		['Run Once'],
		['Stop Watching'],
		['-'],
		['Settings…'],
		['Open at Login', 'checked'],
		['-'],
		['Quit Content Tracker']
	]

	return `<style>
		.desk { width: ${width}px; height: ${height}px; position: relative; overflow: hidden; border-radius: 14px;
			background: radial-gradient(120% 90% at 80% 0%, #2f6fd6 0%, #1a2c63 45%, #0d1024 100%) }
		.bar { height: 30px; display: flex; align-items: center; justify-content: flex-end; gap: 18px; padding: 0 16px;
			background: rgb(255 255 255 / 0.22); backdrop-filter: blur(30px); color: #fff; font-weight: 500 }
		.bar svg { width: 18px; height: 18px }
		.bar svg path, .bar svg circle { stroke: #fff }
		.bar svg circle { fill: #fff }
		.tray { padding: 3px 7px; border-radius: 5px; background: rgb(255 255 255 / 0.28); display: flex }
		.menu { position: absolute; top: 34px; right: 168px; width: 290px; padding: 5px; border-radius: 10px;
			background: rgb(246 246 248 / 0.94); backdrop-filter: blur(30px);
			box-shadow: 0 0 0 0.5px rgb(0 0 0 / 0.25), 0 12px 40px rgb(0 0 0 / 0.35); color: #1d1d1f }
		.menu div { padding: 3px 10px 3px 24px; border-radius: 5px; position: relative }
		.menu .off { color: #8e8e93 }
		.menu .checked::before { content: '✓'; position: absolute; left: 8px }
		.menu .hover { background: #2f6fd6; color: #fff }
		.menu hr { border: 0; border-top: 1px solid rgb(0 0 0 / 0.1); margin: 5px 10px }
	</style>
	<div class="desk">
		<div class="bar">${BATTERY}${WIFI}<span class="tray">${tray}</span><span>Mon 24 Nov&nbsp; 4:33 pm</span></div>
		<div class="menu">${items.map(([label, kind]) => label == '-' ? '<hr>' : `<div class="${kind ?? ''}${label == 'Run Once' ? ' hover' : ''}">${escape(label)}</div>`).join('')}</div>
	</div>`
}

// the app's elements are named for the tests by data-test
selectors.setTestIdAttribute('data-test')

const work = await fs.mkdtemp(path.join(os.tmpdir(), 'content-tracker-screenshots-'))
// the app's given this as its home, so its cache is where cacheFile() works out from here too
process.env.HOME = process.env.LOCALAPPDATA = work
const project = path.join(work, 'Show content')
await writeProject(project)
await fs.mkdir(OUT, { recursive: true })

const oauth = await fakeOAuth({ email: ACCOUNT })
const airtable = await fakeAirtable({ accepts: token => oauth.isValid(token), email: ACCOUNT, bases: [{ id: 'appShowContent01', name: 'Show content' }] })

const app = await electron.launch({
	args: ['.', '--use-mock-keychain', `--force-device-scale-factor=${SCALE}`],
	cwd: ROOT,
	env: {
		...withoutRunAsNode(process.env),
		CONTENT_TRACKER_USER_DATA: path.join(work, 'data'),
		CONTENT_TRACKER_NO_UPDATE_CHECK: '1',
		CONTENT_TRACKER_OAUTH_ENDPOINT: oauth.url,
		AIRTABLE_ENDPOINT_URL: airtable.url,
		AIRTABLE_API_KEY: '',
		HOME: work,
		LOCALAPPDATA: work
	}
})

try {
	const page = await app.firstWindow()
	await app.evaluate(({ BrowserWindow, nativeTheme, dialog, shell }, { width, height, folder }) => {
		nativeTheme.themeSource = 'light'
		BrowserWindow.getAllWindows()[0].setContentSize(width, height)
		dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] })
		dialog.showMessageBox = async () => ({ response: 1 })
		// the sign in's browser: the stand-in sends it straight back
		shell.openExternal = async url => {
			await fetch(url)
		}
	}, { width: WIDTH, height: HEIGHT, folder: project })
	await page.setViewportSize({ width: WIDTH, height: HEIGHT })

	const tab = name => page.getByRole('navigation').getByRole('button', { name }).click()

	// a run's done once there's a new result and it's stopped running
	const run = async button => {
		const before = await page.getByTestId('result').textContent().catch(() => '')
		await page.getByRole('button', { name: button }).click()
		await page.waitForFunction(before => {
			const result = document.querySelector('[data-test=result]')?.textContent
			const status = document.querySelector('[data-test=status]')?.textContent
			return result && result != before && status?.trim() != 'Running'
		}, before)
	}
	const shot = async name => {
		const file = path.join(work, `${name}-app.png`)
		await page.waitForTimeout(300)
		await page.screenshot({ path: file })
		return file
	}

	// set up as someone would: the folder, signed in, the base chosen
	await tab('Settings')
	await page.getByTestId('add-folder').click()
	await page.getByTestId('sign-in-airtable').click()
	await page.getByTestId('airtable-account').waitFor()
	await page.getByTestId('choose-base').click()
	await page.getByTestId('bases').getByRole('button', { name: 'Show content' }).click()
	await page.getByTestId('saved').waitFor()
	await page.locator('.fields').evaluate((fields, shown) => {
		fields.scrollTo(0, 0)
		// where a show's content would be, rather than where the pictures are taken from - shown only, not saved
		fields.querySelector('[data-test=folders] li span').textContent = shown
		fields.querySelector('input[spellcheck=false]').value = shown
	}, '/Volumes/Suite/Show content')
	const pictures = { settings: await shot('settings') }

	await tab('Activity')
	await seedMedia(project)
	await run('Run once')

	// a day's changes, for the dry run to show
	await place(project, '05 Delivery/Opener/Opener_v013.mov', 4096)
	await place(project, '03 Renders/Opener/Opener_v014.mov')
	await fs.rm(path.join(project, '03 Renders/Opener/Opener_v012.mov'))
	await seedMedia(project)
	await run('Run once')
	pictures.activity = await shot('activity')

	await place(project, '05 Delivery/Walk-on/Walkon_v004.mov', 4096)
	await place(project, '05 Delivery/Walk-on/Walkon_v005.mov')
	await fs.rm(path.join(project, '02 Design/Style frames/Opener frame 01.png'))
	await seedMedia(project)
	await run('Dry run')
	await tab('Tracked')
	pictures.tracked = await shot('tracked')

	await tab('Help')
	pictures.help = await shot('help')
	await tab('About')
	pictures.about = await shot('about')

	// each tab in a Mac window
	for(const [name, file] of Object.entries(pictures))
		await draw(app, work, name, macWindow('Content Tracker', `<img src="${file}">`, WIDTH, HEIGHT), framed(WIDTH, HEIGHT))

	await draw(app, work, 'menu-bar', await menuBarPage(720, 330), { width: 720, height: 330 })

	const TABLE = { width: 1330, height: 560 }
	// the tables on their own, as what they look like matters, not the browser they're in
	await draw(app, work, 'google-sheets', sheetsPage(TABLE.width, TABLE.height), TABLE)
	await draw(app, work, 'airtable', airtablePage(TABLE.width, TABLE.height), TABLE)

	console.log(`Taken: ${(await fs.readdir(OUT)).join(', ')}`)
}
finally {
	await app.close()
	await airtable.close()
	await oauth.close()
	await fs.rm(work, { recursive: true, force: true })
}
