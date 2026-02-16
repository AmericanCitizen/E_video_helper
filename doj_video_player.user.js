;// ==UserScript==
// @name         Epstein File Sniper
// @namespace    http://tampermonkey.net/
// @version      3.0
// @description  Magic-byte signature detection of mislabeled files on DOJ Epstein page (v3: single Range request identifies type — no extension loop)
// @author       You
// @updateURL    https://raw.githubusercontent.com/AmericanCitizen/E_video_helper/main/doj_video_player.user.js
// @downloadURL  https://raw.githubusercontent.com/AmericanCitizen/E_video_helper/main/doj_video_player.user.js
// @match        https://www.justice.gov/epstein*
// @match        https://www.justice.gov/age-verify*
// @grant        GM_download
// @grant        GM_xmlhttpRequest
// @grant        GM_setClipboard
// @grant        GM_getResourceURL
// @resource     logo https://raw.githubusercontent.com/AmericanCitizen/E_video_helper/main/logo.png
// @connect      justice.gov
// @connect      *
// @run-at       document-end
// ==/UserScript==

(function () {
    'use strict';

    // --- AUTO-AGE VERIFICATION SOLVER ---
    if (window.location.href.includes('age-verify')) {
        console.log('DOJ Auto-Verifier: Detected Age Verification Page.');

        // Timer to ensure elements are loaded
        setTimeout(() => {
            const btn = document.getElementById('age-button-yes');
            if (btn) {
                console.log('DOJ Auto-Verifier: Clicking "Yes"...');
                btn.click();

                // If opened as a popup by our main script, close self after a moment
                if (window.opener) {
                    console.log('DOJ Auto-Verifier: Closing popup in 2s...');
                    setTimeout(() => window.close(), 2000);
                }
            } else {
                console.warn('DOJ Auto-Verifier: "Yes" button not found!');
            }
        }, 500);

        return; // STOP execution of the main file detector on this page
    }
    // ------------------------------------

    const SCRIPT_VERSION = '3.0';
    const UPDATE_URL = 'https://raw.githubusercontent.com/AmericanCitizen/E_video_helper/main/doj_video_player.user.js';
    console.log(`Epstein File Sniper v${SCRIPT_VERSION}: Signature-first detection engine loaded.`);

    // Default Configuration
    const DEFAULT_CONFIG = {
        MAX_FILE_SIZE: 500 * 1024 * 1024,
        DELAY_MIN: 300,       // 0.3s — CDN HEAD requests are lightweight
        DELAY_MAX: 800,       // 0.8s — tight range for predictable throughput
        BASE_JITTER: 100,     // Minimal randomness to avoid metronomic patterns
        MAX_JITTER: 300,      // Less wasted idle time
        AUTO_CRAWL_DELAY: 1500, // Delay before clicking Next (ms)
        PAGE_LOAD_DELAY: 800,   // Delay after page load before scan (ms)
        BATCH_SIZE: 100,        // Files per batch download
        USE_STEALTH_MODE: true, // Enable advanced anti-bot features
        RANDOMIZE_ORDER: true,  // Shuffle link checking order
        MAX_CONCURRENT: 3,      // 3 parallel requests — biggest speed multiplier
        MAX_BLOB_SIZE_MB: 500,  // Max size for internal blob downloader (RAM dependent)
        SAFETY_BATCH_LIMIT: 100, // Max files to queue at once without warning
        ENABLED_TYPES: {
            video: true,
            archive: true,  // Enabled for finding project files in zips
            image: true,    // Enabled for Photos/Photoshop
            audio: true,
            document: true, // Enabled for Docs
            forensic: true  // Enabled for Evidence logs/images
        },
        // Start empty, will populate
        ENABLED_EXTENSIONS: {},
        AUTO_RENAME_DOWNLOADS: true,  // Rename downloaded files based on detected magic-number type
        PRIORITIZE_MEDIA: false       // If true, ignores found PDFs in Phase 1 and forces deep scan for videos
    };

    let CONFIG = JSON.parse(JSON.stringify(DEFAULT_CONFIG));

    // Download state tracking
    let downloadStats = {
        found: 0,
        downloaded: 0,
        failed: 0
    };

    // Global Scan Queue (to enforce serial manual scans)
    let globalScanQueue = Promise.resolve();

    // File extensions to try (comprehensive: 1990-2026 formats)
    const FILE_EXTENSIONS = {
        // VIDEO: Prioritize popular first, then legacy/surveillance/broadcast
        video: [
            // Modern & Popular
            '.mp4', '.mov', '.avi', '.wmv', '.mkv', '.webm', '.m4v', '.3gp', '.3g2',
            // Flash, MPEG, Camcorder/DVD
            '.flv', '.f4v', '.mpg', '.mpeg', '.mpe', '.ts', '.mts', '.m2ts', '.vob',
            // Legacy/Specific
            '.rm', '.rmvb', '.asf', '.divx', '.ogv', '.mod', '.tod',
            // MPEG variants
            '.mpv', '.m1v', '.m2v', '.mp2v', '.m4p', '.m2p', '.m2t', '.trp', '.tp',
            // Professional/Broadcast
            '.mxf', '.gxf', '.lxf', '.dv', '.dif', '.qt',
            // Surveillance/CCTV/DVR (Keep these!)
            '.dav', '.264', '.h264', '.h265', '.265', '.dv4', '.irf', '.ave', '.sec',
            // Cinema/RAW
            '.r3d', '.braw', '.ari',
            // Video Editing Projects & Intermediates
            '.prproj', '.prel', '.aep', '.aet', '.veg', '.vf', '.drp',
            '.fcpxml', '.imovieproject', '.kdenlive', '.mlt', '.wlmp', '.mswmm',
            // Intermediate/ProRes/DNx codecs (rendered clips)
            '.prores', '.dnxhd', '.dnxhr', '.cineform',
            // Legacy/Game/Niche
            '.swf', '.amv', '.svi', '.nsv', '.roq', '.bik', '.smk', '.ivf',
            '.gifv', '.nut', '.ogm', '.ssif'
        ],
        // ARCHIVE: Compression, disk images, forensic
        archive: [
            '.zip', '.rar', '.7z', '.tar', '.gz', '.iso', '.img',
            // Additional compression
            '.bz2', '.xz', '.lz', '.lzma', '.lzh', '.lha', '.arj', '.z', '.zst',
            // System/Package
            '.cab', '.wim', '.msi', '.dmg',
            // Disk image/Forensic
            '.bin', '.cue', '.nrg', '.mdf', '.e01', '.dd',
            // Compound archives
            '.tgz', '.tbz2', '.txz', '.zipx'
        ],
        // IMAGE: Standard, RAW, scanner/fax, professional
        image: [
            // Standard/Popular
            '.jpg', '.jpeg', '.jfif', '.png', '.gif', '.webp', '.heic', '.tiff', '.tif', '.bmp',
            // Camera RAW (common)
            '.raw', '.cr2', '.nef', '.arw', '.dng', '.orf', '.rw2', '.srw', '.pef', '.raf',
            // Camera RAW (additional)
            '.fff', '.3fr', '.iiq', '.erf', '.kdc', '.dcr', '.sr2', '.srf', '.x3f', '.mrw', '.nrw',
            // JPEG 2000 / HDR
            '.j2k', '.jp2', '.jpx', '.jxr', '.exr', '.hdr',
            // Photoshop / Design / Editing
            '.psd', '.psb', '.pdd', '.psdt',         // Photoshop files & templates
            '.ai', '.ait',                             // Illustrator files & templates
            '.indd', '.indt', '.inx', '.idml',        // InDesign
            '.xcf',                                    // GIMP native
            '.kra',                                    // Krita
            '.afphoto', '.afdesign',                   // Affinity Photo/Designer
            '.cdr', '.cmx',                            // CorelDRAW
            '.sketch',                                 // Sketch
            '.fig',                                    // Figma export
            // Professional/Technical
            '.tga', '.pcx', '.ico', '.svg', '.eps', '.wmf', '.emf',
            // Legacy/Portable
            '.pbm', '.pgm', '.ppm', '.dpx'
        ],
        // AUDIO: Voice/dictation, modern codecs, lossless, legacy
        audio: [
            // Popular/Standard
            '.mp3', '.wav', '.m4a', '.flac', '.aac', '.ogg', '.wma',
            // Voice/Phone recording (critical for legal/gov)
            '.amr', '.dss', '.ds2', '.dvf', '.msv', '.act', '.vox',
            // Modern speech codecs
            '.opus', '.spx',
            // Lossless/Audiophile
            '.ape', '.wv', '.tta', '.shn', '.alac',
            // Uncompressed/Professional
            '.aif', '.aiff', '.aifc', '.au', '.snd', '.caf', '.w64', '.pcm', '.bwf',
            // Legacy/Streaming
            '.ra', '.ram', '.gsm', '.oga', '.mka', '.mpa', '.ac3', '.dts',
            // Audio Editing Projects
            '.aup', '.aup3',                           // Audacity
            '.sesx',                                    // Adobe Audition
            '.ptx', '.ptf',                             // Pro Tools
            '.als', '.alc',                             // Ableton Live
            '.flp',                                     // FL Studio
            '.rpp',                                     // REAPER
            // MIDI
            '.mid', '.midi'
        ],
        // DOCUMENT: Modern, legacy word processors (WordPerfect = US gov standard), OpenDocument, email
        document: [
            // Modern/Common (Excluded .pdf as that is the source we are checking against)
            '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.txt', '.rtf', '.csv',
            '.odt', '.ods', '.odp', '.wpd', '.wps', '.pages', '.numbers', '.key',
            '.md', '.json', '.xml', '.html', '.htm', '.log', '.msg', '.eml', '.vcf'
        ],
        // FORENSIC: Disk images, mobile dumps, logs, crypto
        forensic: [
            // Disk Images / Forensic Containers
            '.E01', '.Ex01', '.ad1', '.dd', '.001', '.raw', '.img', '.vmdk', '.vhd', '.vhdx',
            '.aff', '.aff4', '.dmg', '.iso', '.bin', '.cue',
            '.L01', '.Lx01', '.xry', '.dar', '.000', '.002', // [NEW] Extended Containers
            // Mobile Forensics (Cellebrite, Oxygen, etc)
            '.ufd', '.ufdx', '.ab', '.backup', '.xml', '.plist', '.db', '.sqlite', '.sqlite3',
            '.mbdb', '.mbdx', '.ips', '.itdb', '.itl', '.amcache', '.hve', // [NEW] Mobile/Backup
            // System Logs & Artifacts
            '.evtx', '.evt', '.reg', '.pcap', '.pcapng', '.etl', '.pf', '.lnk',
            // Crypto / Financial
            '.wallet', '.key', '.dat', '.kdbx',
            '.tc', '.vc', '.hc', '.cry', '.axx', // [NEW] Encrypted
            // Email Containers
            '.pst', '.ost', '.mbox', '.dbx',
            // Database
            '.db-wal', '.db-shm', `.mdb`, `.accdb` // [NEW] Database
        ]
    };

    // Global UI Feedback
    function setStatus(msg, type = 'info') {
        const sb = document.getElementById('doj-status-bar');
        const txt = document.getElementById('doj-status-text');
        const icon = document.getElementById('doj-status-icon');
        if (sb && txt) {
            sb.style.display = 'flex';
            txt.textContent = msg;

            // Set colors based on type
            if (type === 'error') {
                sb.style.borderColor = '#ef4444';
                txt.style.color = '#ef4444';
                if (icon) icon.textContent = '🛑';
            } else if (type === 'success') {
                sb.style.borderColor = '#10b981';
                txt.style.color = '#10b981';
                if (icon) icon.textContent = '✅';
            } else {
                sb.style.borderColor = 'rgba(255,255,255,0.1)';
                txt.style.color = 'rgba(255,255,255,0.8)';
                if (icon) icon.textContent = '⏳';
            }
        }
    }

    // Top 5 per category – used only by the Settings panel "Top 5" shortcut button
    const TOP_EXTENSIONS = {
        video: ['.mp4', '.mov', '.avi', '.mkv', '.wmv'],
        audio: ['.mp3', '.wav', '.m4a', '.flac', '.aac'],
        image: ['.jpg', '.png', '.gif', '.webp', '.jpeg'],
        archive: ['.zip', '.rar', '.7z', '.tar', '.gz'],
        document: ['.doc', '.docx', '.xls', '.xlsx'],
        forensic: ['.E01', '.dd', '.zip', '.iso', '.img']
    };

    const ALL_EXTENSIONS = Object.values(FILE_EXTENSIONS).flat();
    const resolvedLinks = new Set(); // Track links resolved this session (dedup optimisation)
    const scanningUrls = new Set();  // Track URLs currently being scanned (UI state)

    // State Manager initialized below
    let activeTab = 'found'; // Default tab


    // Realistic User Agents (rotate through these)
    const USER_AGENTS = [
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36 Edg/119.0.0.0',
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15'
    ];

    // Generate realistic browser headers
    function getRealisticHeaders(url) {
        const urlObj = new URL(url);
        const userAgent = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];

        return {
            'User-Agent': userAgent,
            'Accept': '*/*',
            'Accept-Language': 'en-US,en;q=0.9',
            'Accept-Encoding': 'gzip, deflate, br',
            'Referer': urlObj.origin + '/',
            'Origin': urlObj.origin,
            'DNT': '1',
            'Connection': 'keep-alive',
            'Sec-Fetch-Dest': 'empty',
            'Sec-Fetch-Mode': 'cors',
            'Sec-Fetch-Site': 'same-origin',
            'Cache-Control': 'no-cache',
            'Pragma': 'no-cache'
        };
    }

    // Shuffle array (Fisher-Yates)
    function shuffleArray(array) {
        const arr = [...array];
        for (let i = arr.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [arr[i], arr[j]] = [arr[j], arr[i]];
        }
        return arr;
    }

    // ============================================================
    // MAGIC BYTE SIGNATURE DETECTION
    // One Range request on the .pdf URL reveals the actual file
    // type, replacing the 100+ extension trial loop entirely.
    // ============================================================

    // Each entry: { ext, cat, match(Uint8Array) → boolean }
    // Ordered from most-specific to least-specific to avoid ambiguity.
    const FILE_SIGNATURES = [
        // --- VIDEO ---
        // MKV / WebM (EBML header)
        { ext: '.mkv', cat: 'video', match: b => b[0] === 0x1A && b[1] === 0x45 && b[2] === 0xDF && b[3] === 0xA3 },
        // ASF / WMV / WMA
        { ext: '.wmv', cat: 'video', match: b => b[0] === 0x30 && b[1] === 0x26 && b[2] === 0xB2 && b[3] === 0x75 && b[4] === 0x8E && b[5] === 0x66 && b[6] === 0xCF && b[7] === 0x11 },
        // HEIC / HEIF – "ftyp" box at offset 4, brand "heic" at offset 8
        { ext: '.heic', cat: 'image', match: b => b.length >= 12 && b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70 && b[8] === 0x68 && b[9] === 0x65 && b[10] === 0x69 && b[11] === 0x63 },
        // HEIF – "ftyp" box with "mif1" brand
        { ext: '.heif', cat: 'image', match: b => b.length >= 12 && b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70 && b[8] === 0x6D && b[9] === 0x69 && b[10] === 0x66 && b[11] === 0x31 },
        // AVIF – "ftyp" box with "avif" brand
        { ext: '.avif', cat: 'image', match: b => b.length >= 12 && b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70 && b[8] === 0x61 && b[9] === 0x76 && b[10] === 0x69 && b[11] === 0x66 },
        // 3GP – "ftyp" box with "3gp" brand at offset 8
        { ext: '.3gp', cat: 'video', match: b => b.length >= 11 && b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70 && b[8] === 0x33 && b[9] === 0x67 && b[10] === 0x70 },
        // M4A – "ftyp" box with "M4A " brand
        { ext: '.m4a', cat: 'audio', match: b => b.length >= 12 && b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70 && b[8] === 0x4D && b[9] === 0x34 && b[10] === 0x41 && b[11] === 0x20 },
        // MPEG-4 / MOV / 3GP – "ftyp" box at byte offset 4
        { ext: '.mp4', cat: 'video', match: b => b.length >= 8 && b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70 },
        // AVI  (RIFF....AVI )
        { ext: '.avi', cat: 'video', match: b => b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x41 && b[9] === 0x56 && b[10] === 0x49 && b[11] === 0x20 },
        // FLV
        { ext: '.flv', cat: 'video', match: b => b[0] === 0x46 && b[1] === 0x4C && b[2] === 0x56 },
        // MPEG Program/Transport Stream
        { ext: '.mpg', cat: 'video', match: b => b[0] === 0x00 && b[1] === 0x00 && b[2] === 0x01 && (b[3] === 0xBA || b[3] === 0xB3) },

        // --- AUDIO ---
        // MP3 with ID3 tag
        { ext: '.mp3', cat: 'audio', match: b => b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33 },
        // MP3 raw frame sync
        { ext: '.mp3', cat: 'audio', match: b => b[0] === 0xFF && (b[1] === 0xFB || b[1] === 0xF3 || b[1] === 0xF2) },
        // FLAC
        { ext: '.flac', cat: 'audio', match: b => b[0] === 0x66 && b[1] === 0x4C && b[2] === 0x61 && b[3] === 0x43 },
        // OGG / OGA / OGV
        { ext: '.ogg', cat: 'audio', match: b => b[0] === 0x4F && b[1] === 0x67 && b[2] === 0x67 && b[3] === 0x53 },
        // WAV  (RIFF....WAVE)
        { ext: '.wav', cat: 'audio', match: b => b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x41 && b[10] === 0x56 && b[11] === 0x45 },
        // MIDI
        { ext: '.mid', cat: 'audio', match: b => b[0] === 0x4D && b[1] === 0x54 && b[2] === 0x68 && b[3] === 0x64 },
        // AAC (ADTS frame sync)
        { ext: '.aac', cat: 'audio', match: b => b[0] === 0xFF && (b[1] === 0xF1 || b[1] === 0xF9) },

        // --- IMAGE ---
        // PNG
        { ext: '.png', cat: 'image', match: b => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47 && b[4] === 0x0D && b[5] === 0x0A && b[6] === 0x1A && b[7] === 0x0A },
        // JPEG
        { ext: '.jpg', cat: 'image', match: b => b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF },
        // GIF
        { ext: '.gif', cat: 'image', match: b => b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38 },
        // WebP  (RIFF....WEBP)
        { ext: '.webp', cat: 'image', match: b => b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50 },
        // TIFF little-endian
        { ext: '.tif', cat: 'image', match: b => b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2A && b[3] === 0x00 },
        // TIFF big-endian
        { ext: '.tif', cat: 'image', match: b => b[0] === 0x4D && b[1] === 0x4D && b[2] === 0x00 && b[3] === 0x2A },
        // PSD
        { ext: '.psd', cat: 'image', match: b => b[0] === 0x38 && b[1] === 0x42 && b[2] === 0x50 && b[3] === 0x53 },
        // JPEG 2000
        { ext: '.jp2', cat: 'image', match: b => b[0] === 0x00 && b[1] === 0x00 && b[2] === 0x00 && b[3] === 0x0C && b[4] === 0x6A && b[5] === 0x50 },
        // BMP
        { ext: '.bmp', cat: 'image', match: b => b[0] === 0x42 && b[1] === 0x4D },
        // ICO (Windows icon)
        { ext: '.ico', cat: 'image', match: b => b[0] === 0x00 && b[1] === 0x00 && b[2] === 0x01 && b[3] === 0x00 },

        // --- ARCHIVE ---
        // ZIP  (also DOCX, XLSX, EPUB, JAR, APK, etc.)
        { ext: '.zip', cat: 'archive', match: b => b[0] === 0x50 && b[1] === 0x4B && (b[2] === 0x03 || b[2] === 0x05 || b[2] === 0x07) },
        // RAR v1.5+
        { ext: '.rar', cat: 'archive', match: b => b[0] === 0x52 && b[1] === 0x61 && b[2] === 0x72 && b[3] === 0x21 && b[4] === 0x1A && b[5] === 0x07 },
        // 7-Zip
        { ext: '.7z', cat: 'archive', match: b => b[0] === 0x37 && b[1] === 0x7A && b[2] === 0xBC && b[3] === 0xAF && b[4] === 0x27 && b[5] === 0x1C },
        // GZIP
        { ext: '.gz', cat: 'archive', match: b => b[0] === 0x1F && b[1] === 0x8B },
        // BZIP2
        { ext: '.bz2', cat: 'archive', match: b => b[0] === 0x42 && b[1] === 0x5A && b[2] === 0x68 },
        // XZ
        { ext: '.xz', cat: 'archive', match: b => b[0] === 0xFD && b[1] === 0x37 && b[2] === 0x7A && b[3] === 0x58 && b[4] === 0x5A && b[5] === 0x00 },
        // LZ4
        { ext: '.lz4', cat: 'archive', match: b => b[0] === 0x04 && b[1] === 0x22 && b[2] === 0x4D && b[3] === 0x18 },
        // Zstandard
        { ext: '.zst', cat: 'archive', match: b => b[0] === 0x28 && b[1] === 0xB5 && b[2] === 0x2F && b[3] === 0xFD },
        // Microsoft Cabinet
        { ext: '.cab', cat: 'archive', match: b => b[0] === 0x4D && b[1] === 0x53 && b[2] === 0x43 && b[3] === 0x46 },

        // --- DOCUMENT ---
        // OLE2 Compound File  (DOC / XLS / PPT / MSG / MSI)
        { ext: '.doc', cat: 'document', match: b => b[0] === 0xD0 && b[1] === 0xCF && b[2] === 0x11 && b[3] === 0xE0 && b[4] === 0xA1 && b[5] === 0xB1 && b[6] === 0x1A && b[7] === 0xE1 },
        // RTF
        { ext: '.rtf', cat: 'document', match: b => b[0] === 0x7B && b[1] === 0x5C && b[2] === 0x72 && b[3] === 0x74 && b[4] === 0x66 },

        // --- FORENSIC ---
        // EnCase EWF v1
        { ext: '.e01', cat: 'forensic', match: b => b[0] === 0x45 && b[1] === 0x56 && b[2] === 0x46 },
        // PCAP (LE & BE)
        { ext: '.pcap', cat: 'forensic', match: b => (b[0] === 0xD4 && b[1] === 0xC3 && b[2] === 0xB2 && b[3] === 0xA1) || (b[0] === 0xA1 && b[1] === 0xB2 && b[2] === 0xC3 && b[3] === 0xD4) },
        // PCAP-NG
        { ext: '.pcapng', cat: 'forensic', match: b => b[0] === 0x0A && b[1] === 0x0D && b[2] === 0x0D && b[3] === 0x0A },
        // SQLite
        { ext: '.db', cat: 'forensic', match: b => b[0] === 0x53 && b[1] === 0x51 && b[2] === 0x4C && b[3] === 0x69 && b[4] === 0x74 && b[5] === 0x65 && b[6] === 0x20 },
    ];

    // Match a Uint8Array against the signatures table, return first hit or null.
    function detectFileTypeFromMagicBytes(bytes) {
        if (!bytes || bytes.length < 4) return null;
        for (const sig of FILE_SIGNATURES) {
            try { if (sig.match(bytes)) return sig; } catch (_) { }
        }
        return null;
    }

    // Fetch first 64 bytes of a URL using a Range request.
    // Uses stream reader + cancel so we never download the full file,
    // even if the server ignores the Range header and returns 200 + full body.
    // Returns Uint8Array (up to 64 bytes) on success, null on failure.
    async function fetchMagicBytes(url) {
        try {
            const headers = {
                ...(CONFIG.USE_STEALTH_MODE ? getRealisticHeaders(url) : {}),
                'Range': 'bytes=0-63'
            };
            const controller = new AbortController();
            const tid = setTimeout(() => controller.abort(), 8000);
            const response = await fetch(url, {
                method: 'GET', headers, signal: controller.signal,
                credentials: 'include', redirect: 'follow'
            });
            clearTimeout(tid);

            if (response.ok || response.status === 206) {
                // Stream-read exactly the first 64 bytes then cancel.
                // Critical: avoids buffering the full file if server ignores Range header.
                const reader = response.body.getReader();
                const result = new Uint8Array(64);
                let filled = 0;
                try {
                    while (filled < 64) {
                        const { done, value } = await reader.read();
                        if (done || !value) break;
                        const take = Math.min(value.length, 64 - filled);
                        result.set(value.subarray(0, take), filled);
                        filled += take;
                    }
                } finally {
                    reader.cancel(); // Stop downloading the rest immediately
                }
                const bytes = result.subarray(0, filled);
                console.debug(`fetchMagicBytes: got ${filled} bytes from ${url.split('/').pop()} | hex: ${Array.from(bytes.subarray(0, 8)).map(b => b.toString(16).padStart(2, '0')).join(' ')}`);
                return bytes;
            }
            console.debug(`fetchMagicBytes: status ${response.status} for ${url.split('/').pop()}`);
        } catch (e) {
            console.debug(`fetchMagicBytes failed for ${url.split('/').pop()}:`, e.message);
        }
        return null;
    }

    // One-shot type identification via magic bytes.
    //
    // Strategy:
    //   1. Probe the .pdf URL itself — works when the file is truly mislabeled
    //      (the server serves video/archive bytes at the .pdf URL).
    //   2. If the .pdf URL returns actual PDF bytes (%PDF) or an unrecognized
    //      signature, probe the most-likely candidate extension URLs directly.
    //      This covers the case where the DOJ serves a real PDF at .pdf but
    //      also hosts the same content as .mp4/.avi/etc. at a parallel URL.
    //
    // Returns a fileData-compatible object or null (triggers extension loop fallback).
    async function snipeFileType(pdfUrl) {
        // Step 1: probe the .pdf URL itself
        const pdfBytes = await fetchMagicBytes(pdfUrl);
        if (pdfBytes) {
            // Early exit: if the .pdf URL genuinely serves PDF content, stop immediately.
            // %PDF- magic bytes (25 50 44 46) — no extension probing needed.
            if (pdfBytes[0] === 0x25 && pdfBytes[1] === 0x50 && pdfBytes[2] === 0x44 && pdfBytes[3] === 0x46) {
                // Check if PDF scan is enabled. If disabled, ignore the PDF and probe for other extensions.
                const isPdfEnabled = CONFIG.ENABLED_TYPES.document !== false && CONFIG.ENABLED_EXTENSIONS['.pdf'] !== false;

                if (isPdfEnabled) {
                    console.log(`Confirmed real PDF via magic bytes: ${pdfUrl.split('/').pop()}`);
                    setStatus && setStatus(`Signature Verified: PDF (${pdfUrl.split('/').pop()})`, 'success');
                    return {
                        success: true, url: pdfUrl, size: null, type: 'document/pdf',
                        extension: '.pdf', category: 'document', confirmedPdf: true
                    };
                } else {
                    console.log(`Ignored real PDF (disabled in config): ${pdfUrl.split('/').pop()}`);
                    // Fall through -> will probe candidates in Step 2
                }
            }

            // Check for HTML response (Access Denied / 404 Page)
            // Common starting bytes for HTML:
            // 3C 21 44 4F 43 54 59 50 45 (<!DOCTYPE)
            // 3C 68 74 6D 6C (<html)
            // 3C 48 54 4D 4C (<HTML)
            const isHtml = (pdfBytes[0] === 0x3C && pdfBytes[1] === 0x21) || // <!
                (pdfBytes[0] === 0x3C && (pdfBytes[1] === 0x68 || pdfBytes[1] === 0x48)); // <h or <H

            if (isHtml) {
                console.warn(`Server returned HTML page (Access Denied / 404) for: ${pdfUrl.split('/').pop()}`);
                // Verify if it's an age verification page or generic error
                const decoder = new TextDecoder('utf-8');
                const textPreview = decoder.decode(pdfBytes).substring(0, 60).replace(/\n/g, ' ');
                console.warn(`HTML Preview: ${textPreview}...`);
                return null; // Stop processing this URL
            }

            const sig = detectFileTypeFromMagicBytes(pdfBytes);
            if (sig) {
                console.log(`Signature HIT on .pdf URL: ${sig.ext} (${sig.cat}) for ${pdfUrl.split('/').pop()}`);
                // Confirm with the extension-swapped URL to get real size/headers.
                const confirmed = await testFileUrl(pdfUrl, sig.ext);
                if (confirmed.success) return confirmed;
                // Fallback: original URL already serves the right content.
                return {
                    success: true, url: pdfUrl, size: pdfBytes.length,
                    type: `${sig.cat}/${sig.ext.slice(1)}`, extension: sig.ext, category: sig.cat
                };
            }
            // Log the first bytes so the developer can see what we're getting
            const hex = Array.from(pdfBytes.subarray(0, 8)).map(b => b.toString(16).padStart(2, '0')).join(' ');
            console.debug(`Signature MISS on .pdf URL (${pdfUrl.split('/').pop()}): first bytes = ${hex}`);
        }

        // Step 2: probe candidate extensions from the user's enabled list.
        // The .pdf URL is a real PDF; the non-PDF version lives at a different URL.
        const candidates = ALL_EXTENSIONS.filter(ext => {
            const cat = getFileCategory(ext);
            // Only include extensions that are explicitly enabled in settings
            return CONFIG.ENABLED_TYPES[cat] && CONFIG.ENABLED_EXTENSIONS[ext] !== false;
        });

        // Use a randomized or ordered list based on config (optional, but good for distribution)
        const probeList = CONFIG.RANDOMIZE_ORDER ? shuffleArray(candidates) : candidates;

        console.log(`Probing ${probeList.length} candidate extensions for ${pdfUrl.split('/').pop()}...`);

        for (const ext of probeList) {
            const candidateBytes = await fetchMagicBytes(
                (() => { try { const u = new URL(pdfUrl); u.pathname = u.pathname.replace(/\.pdf$/i, ext); return u.toString(); } catch (_) { return pdfUrl.replace(/\.pdf$/i, ext); } })()
            );

            // If fetch failed or returned HTML, skip
            if (!candidateBytes) continue;
            // HTML check for candidates too
            if ((candidateBytes[0] === 0x3C && candidateBytes[1] === 0x21) ||
                (candidateBytes[0] === 0x3C && (candidateBytes[1] === 0x68 || candidateBytes[1] === 0x48))) {
                continue;
            }

            const sig = detectFileTypeFromMagicBytes(candidateBytes);
            if (sig) {
                // SOFT 404 CHECK: If we asked for .avi/.zip etc and got a .pdf back, REJECT it.
                if (sig.ext === '.pdf' && ext !== '.pdf') {
                    console.warn(`[Snipe Probe] Soft 404: Probed ${ext}, got PDF signature. Skipping.`);
                    continue;
                }

                console.log(`Signature HIT on candidate ${ext}: confirmed as ${sig.ext} (${sig.cat})`);
                const candidateUrl = (() => { try { const u = new URL(pdfUrl); u.pathname = u.pathname.replace(/\.pdf$/i, sig.ext); return u.toString(); } catch (_) { return pdfUrl.replace(/\.pdf$/i, sig.ext); } })();
                const confirmed = await testFileUrl(pdfUrl, sig.ext);
                if (confirmed.success) return confirmed;
                return {
                    success: true, url: candidateUrl, size: candidateBytes.length,
                    type: `${sig.cat}/${sig.ext.slice(1)}`, extension: sig.ext, category: sig.cat
                };
            }
        }

        return null; // All probes failed
    }

    // Initialize Config with Extensions
    function initConfig() {
        // Ensure all extensions exist in config
        ALL_EXTENSIONS.forEach(ext => {
            if (CONFIG.ENABLED_EXTENSIONS[ext] === undefined) {
                // Default to true
                CONFIG.ENABLED_EXTENSIONS[ext] = true;
            }
        });

        loadConfig();
    }

    function loadConfig() {
        const saved = localStorage.getItem('doj_config');
        if (saved) {
            try {
                const parsed = JSON.parse(saved);
                // Merge saved config
                CONFIG = { ...CONFIG, ...parsed };
                // Ensure extensions object exists if old config
                if (!CONFIG.ENABLED_EXTENSIONS) CONFIG.ENABLED_EXTENSIONS = {};
                ALL_EXTENSIONS.forEach(ext => {
                    if (CONFIG.ENABLED_EXTENSIONS[ext] === undefined) CONFIG.ENABLED_EXTENSIONS[ext] = true;
                });

            } catch (e) {
                console.error('Failed to load config', e);
            }
        }
    }

    function saveConfig() {
        localStorage.setItem('doj_config', JSON.stringify(CONFIG));
        console.log('Config saved');
    }

    function injectStyles() {
        const style = document.createElement('style');
        style.textContent = `
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;600;800&family=Playfair+Display:wght@700&display=swap');

        /* CINEMATIC THEME VARIABLES */
        :root {
            --cin-black: #050505;
            --cin-dark-gray: #0a0a0a;
            --cin-gold: #d4af37;
            --cin-gold-dim: #8a7c55;
            --cin-red: #8a0000;
            --cin-red-bright: #ff0000;
            --cin-fog: rgba(10, 10, 10, 0.85);
            --cin-glass: rgba(255, 255, 255, 0.03);
            --cin-shadow: 0 10px 30px rgba(0, 0, 0, 0.9);
        }

        /* Prevent userscript elements from interfering with DOJ site handlers */
        [data-userscript="true"],
        [data-userscript="true"] * {
            pointer-events: auto !important;
        }

        #doj-file-detector {
            position: fixed;
            top: 20px;
            right: 20px;
            width: 380px;
            background: radial-gradient(circle at top right, #1a0505, var(--cin-black));
            color: #e0e0e0;
            border-radius: 4px;
            box-shadow:
                0 0 20px rgba(0, 0, 0, 1),
                0 0 40px rgba(138, 0, 0, 0.2);
            z-index: 10000;
            font-family: 'Inter', sans-serif;
            overflow: hidden;
            border: 1px solid var(--cin-gold-dim);
            outline: 1px solid rgba(0, 0, 0, 0.8);
        }

        /* Foggy overlay effect */
        #doj-file-detector::before {
            content: '';
            position: absolute;
            top: 0; left: 0; right: 0; height: 100px;
            background: linear-gradient(to bottom, rgba(138, 0, 0, 0.15), transparent);
            pointer-events: none;
            z-index: 0;
        }

        #doj-file-detector:hover {
            box-shadow:
                0 0 25px rgba(0, 0, 0, 1),
                0 0 50px rgba(212, 175, 55, 0.1);
        }

        .doj-header {
            position: relative;
            padding: 20px 24px;
            background: linear-gradient(to bottom, rgba(0, 0, 0, 0.8), rgba(0, 0, 0, 0.6));
            border-bottom: 1px solid var(--cin-gold-dim);
            display: flex;
            align-items: center;
            gap: 16px;
            z-index: 1;
        }

        .doj-logo {
            width: 70px;
            height: 70px;
            border-radius: 4px;
            object-fit: cover;
            box-shadow: 0 5px 15px rgba(0, 0, 0, 0.8);
            border: 1px solid var(--cin-gold);
            filter: contrast(1.2) sepia(0.2);
        }

        .doj-title-group {
            flex: 1;
        }

        .doj-title {
            font-family: 'Playfair Display', serif;
            font-size: 18px;
            font-weight: 800;
            margin: 0;
            color: #fff;
            letter-spacing: 0.05em;
            text-transform: uppercase;
            text-shadow:
                2px 2px 0px #000,
                0 0 10px var(--cin-red),
                0 0 20px var(--cin-red);
        }

        .doj-subtitle {
            font-size: 10px;
            color: var(--cin-gold);
            margin-top: 4px;
            letter-spacing: 0.15em;
            text-transform: uppercase;
            opacity: 0.8;
            font-weight: 600;
        }

        .doj-min-btn {
            background: transparent;
            border: 1px solid var(--cin-gold-dim);
            width: 24px;
            height: 24px;
            color: var(--cin-gold);
            font-size: 14px;
            cursor: pointer;
            transition: all 0.3s;
            display: flex;
            align-items: center;
            justify-content: center;
            margin-left: auto;
            border-radius: 2px;
        }

        .doj-min-btn:hover {
            background: var(--cin-gold);
            color: #000;
            box-shadow: 0 0 10px var(--cin-gold);
        }

        .doj-icon-btn {
            background: transparent;
            border: none;
            width: 32px;
            height: 32px;
            color: #888;
            font-size: 16px;
            cursor: pointer;
            transition: all 0.3s;
            display: flex;
            align-items: center;
            justify-content: center;
            margin-left: 4px;
        }

        .doj-icon-btn:hover {
            color: var(--cin-gold);
            text-shadow: 0 0 5px var(--cin-gold);
        }

        .doj-inline-search-btn {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            width: 22px;
            height: 22px;
            background: rgba(0, 0, 0, 0.8);
            border: 1px solid var(--cin-gold);
            border-radius: 50%;
            margin-left: 8px;
            cursor: pointer;
            transition: all 0.2s;
            z-index: 9999;
            vertical-align: middle;
            font-size: 12px;
            color: var(--cin-gold);
            box-shadow: 0 0 5px rgba(212, 175, 55, 0.3);
        }
        .doj-inline-search-btn:hover {
            background: var(--cin-gold);
            color: #000;
            transform: scale(1.1);
            box-shadow: 0 0 10px var(--cin-gold);
        }

        .doj-body {
            padding: 20px;
            max-height: 500px;
            overflow-y: auto;
            overflow-x: hidden;
            background: linear-gradient(to bottom, #050505, #0a0a0a);
            scrollbar-width: thin;
            scrollbar-color: var(--cin-red) #000;
        }

        .doj-body::-webkit-scrollbar {
            width: 6px;
        }

        .doj-body::-webkit-scrollbar-track {
            background: #000;
        }

        .doj-body::-webkit-scrollbar-thumb {
            background-color: var(--cin-red);
            border-radius: 0;
            border: 1px solid #330000;
        }

        .doj-toggle {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 12px 16px;
            background: rgba(0, 0, 0, 0.6);
            border: 1px solid #222;
            margin-bottom: 16px;
            border-left: 2px solid var(--cin-gold-dim);
        }

        .doj-toggle-label {
            font-size: 12px;
            color: #ccc;
            font-weight: 500;
            display: flex;
            flex-direction: column;
            text-transform: uppercase;
            letter-spacing: 0.05em;
        }

        .doj-toggle-sub {
            font-size: 9px;
            color: #666;
            margin-top: 4px;
            font-weight: normal;
            text-transform: none;
        }

        .doj-switch {
            position: relative;
            width: 40px;
            height: 20px;
        }

        .doj-switch input { opacity: 0; width: 0; height: 0; }

        .doj-slider {
            position: absolute;
            cursor: pointer;
            top: 0; left: 0; right: 0; bottom: 0;
            background-color: #222;
            transition: .4s;
            border: 1px solid #444;
        }

        .doj-slider:before {
            position: absolute;
            content: "";
            height: 14px;
            width: 14px;
            left: 2px;
            bottom: 2px;
            background-color: #666;
            transition: .4s;
        }

        .doj-switch input:checked + .doj-slider {
            background-color: #330000;
            border-color: var(--cin-red);
        }

        .doj-switch input:checked + .doj-slider:before {
            transform: translateX(20px);
            background-color: var(--cin-red-bright);
            box-shadow: 0 0 8px var(--cin-red-bright);
        }

        .doj-btn-group {
            display: flex;
            gap: 12px;
            margin-bottom: 20px;
        }

        .doj-btn {
            position: relative;
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 8px;
            padding: 12px 18px;
            border-radius: 0;
            font-size: 11px;
            font-weight: 700;
            cursor: pointer;
            transition: all 0.3s;
            text-transform: uppercase;
            letter-spacing: 0.1em;
            overflow: hidden;
        }

        /* Breaking Chains Button Style */
        .doj-btn-primary {
            background: linear-gradient(45deg, #222, #000);
            color: var(--cin-gold);
            border: 1px solid var(--cin-gold);
            box-shadow: inset 0 0 10px rgba(0, 0, 0, 0.8);
        }

        .doj-btn-primary:hover {
            background: var(--cin-gold);
            color: #000;
            box-shadow: 0 0 20px rgba(212, 175, 55, 0.4);
        }

        .doj-btn-success {
            background: linear-gradient(45deg, #300, #100);
            color: #fff;
            border: 1px solid var(--cin-red);
        }

        .doj-btn-success:hover {
            background: var(--cin-red);
            box-shadow: 0 0 20px rgba(255, 0, 0, 0.3);
        }

        .doj-btn-secondary {
            background: transparent;
            color: #888;
            border: 1px solid #333;
        }

        .doj-btn-secondary:hover {
            border-color: #666;
            color: #fff;
        }

        .doj-progress {
            background: #111;
            border: 1px solid #333;
            height: 4px;
            margin-bottom: 12px;
            position: relative;
        }

        .doj-progress-bar {
            height: 100%;
            background: var(--cin-gold);
            box-shadow: 0 0 10px var(--cin-gold);
            width: 0%;
            transition: width 0.3s;
        }

        .doj-progress-text {
            font-size: 10px;
            color: var(--cin-gold);
            margin-bottom: 16px;
            text-align: right;
            font-family: monospace;
        }

        .doj-stats {
            display: grid;
            grid-template-columns: repeat(4, 1fr);
            gap: 1px;
            background: var(--cin-gold-dim);
            border: 1px solid var(--cin-gold-dim);
            margin-bottom: 20px;
        }

        .doj-stat {
            background: #080808;
            padding: 10px 4px;
            text-align: center;
        }

        .doj-stat-value {
            font-size: 18px;
            font-weight: 700;
            color: #fff;
            text-shadow: 0 0 5px rgba(255, 255, 255, 0.2);
        }

        .doj-stat-label {
            font-size: 8px;
            color: #888;
            text-transform: uppercase;
            letter-spacing: 1px;
            margin-top: 4px;
        }

        .doj-file-list {
            max-height: 250px;
            overflow-y: auto;
            border-top: 1px solid #222;
        }

        .doj-file-item {
            display: flex;
            align-items: center;
            gap: 12px;
            padding: 12px;
            background: rgba(255, 255, 255, 0.02);
            border-bottom: 1px solid #1a1a1a;
            transition: all 0.2s;
        }

        .doj-file-item:hover {
            background: linear-gradient(90deg, transparent, rgba(212, 175, 55, 0.05), transparent);
            border-color: var(--cin-gold-dim);
        }

        /* LARGE FILE / UNSTABLE STYLING */
        .doj-file-item.too-large {
            background: linear-gradient(90deg, rgba(245, 158, 11, 0.05), rgba(245, 158, 11, 0.1), rgba(245, 158, 11, 0.05));
            border-left: 3px solid #f59e0b;
            box-shadow: inset 0 0 15px rgba(245, 158, 11, 0.1);
        }

        .doj-file-item.too-large .doj-file-name {
            color: #fcd34d;
        }

        .doj-unstable-badge {
            display: inline-flex;
            align-items: center;
            gap: 4px;
            padding: 2px 6px;
            background: rgba(239, 68, 68, 0.1);
            border: 1px solid #ef4444;
            color: #ef4444;
            font-size: 9px;
            font-weight: 800;
            border-radius: 2px;
            text-transform: uppercase;
            letter-spacing: 0.05em;
            margin-left: 8px;
        }

        .doj-file-item.scanning {
            background: rgba(138, 0, 0, 0.1);
            border-left: 2px solid var(--cin-red-bright);
            box-shadow: inset 0 0 20px rgba(138, 0, 0, 0.2);
        }

        .doj-file-icon {
            width: 32px;
            height: 32px;
            background: #111;
            border: 1px solid #333;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 14px;
            color: #666;
        }

        .doj-file-item.scanning .doj-file-icon {
            border-color: var(--cin-red);
            color: var(--cin-red-bright);
            animation: pulse-red 1s infinite;
        }

        .doj-file-info {
            flex: 1;
            min-width: 0;
        }

        .doj-file-name {
            font-size: 12px;
            color: #ccc;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }

        .doj-file-size {
            font-size: 10px;
            color: #666;
            font-family: monospace;
        }

        .doj-file-dl {
            padding: 6px 10px;
            background: transparent;
            border: 1px solid #444;
            color: #888;
            font-size: 10px;
            cursor: pointer;
            transition: all 0.2s;
            text-transform: uppercase;
        }

        .doj-file-dl:hover {
            border-color: var(--cin-gold);
            color: var(--cin-gold);
            background: rgba(212, 175, 55, 0.05);
        }

        @keyframes pulse-red {
            0% { box-shadow: 0 0 0 0 rgba(255, 0, 0, 0.4); }
            70% { box-shadow: 0 0 0 6px rgba(255, 0, 0, 0); }
            100% { box-shadow: 0 0 0 0 rgba(255, 0, 0, 0); }
        }

        .doj-media-body img {
            max-width: 100%;
            max-height: 70vh;
            border-radius: 4px;
        }

        /* Modal Styles */
        .doj-media-content, .doj-settings-content {
            position: relative;
            width: 90%;
            max-width: 1000px;
            max-height: 90vh;
            background: #0a0a0a;
            border: 1px solid var(--cin-gold-dim);
            box-shadow: 0 20px 50px rgba(0, 0, 0, 0.9);
            color: #ccc;
            border-radius: 4px;
            overflow-y: auto;
        }

        .doj-modal-header {
            border-bottom: 1px solid #222;
            padding: 16px 20px;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }

        .doj-modal-title {
            color: var(--cin-gold);
            font-family: 'Playfair Display', serif;
            font-size: 16px;
            font-weight: 700;
        }

        .doj-close-modal {
            color: #666;
            background: transparent;
            border: none;
            font-size: 20px;
            cursor: pointer;
        }
        .doj-close-modal:hover {
            color: var(--cin-red-bright);
        }

        /* Inline Result Styles */
        .doj-inline-result {
            display: inline-flex;
            align-items: center;
            gap: 12px;
            padding: 8px 16px;
            margin: 8px 0 16px 0;
            background: linear-gradient(135deg, rgba(20, 20, 30, 0.95), rgba(30, 30, 45, 0.95));
            border: 1px solid rgba(139, 92, 246, 0.3);
            border-left: 4px solid #8b5cf6;
            border-radius: 8px;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
            animation: slideDown 0.3s ease-out forwards;
            max-width: fit-content;
        }

        @keyframes slideDown {
            from { opacity: 0; transform: translateY(-10px); }
            to { opacity: 1; transform: translateY(0); }
        }

        .doj-inline-icon {
            font-size: 20px;
        }

        .doj-inline-info {
            display: flex;
            flex-direction: column;
        }

        .doj-inline-name {
            font-weight: 600;
            color: #fff;
            font-size: 13px;
        }

        .doj-inline-meta {
            font-size: 11px;
            color: rgba(255, 255, 255, 0.6);
        }

        .doj-inline-actions {
            display: flex;
            gap: 8px;
            margin-left: 8px;
        }

        /* Category Count Badges */
        .doj-category-counts {
            display: flex;
            flex-wrap: wrap;
            gap: 6px;
            padding: 10px 12px;
            background: rgba(255, 255, 255, 0.03);
            border-radius: 10px;
            margin-bottom: 12px;
        }

        .doj-cat-badge {
            display: flex;
            align-items: center;
            gap: 5px;
            background: rgba(255, 255, 255, 0.05);
            padding: 4px 10px;
            border-radius: 20px;
            font-size: 11px;
            font-weight: 600;
            color: rgba(255, 255, 255, 0.9);
            border: 1px solid rgba(255, 255, 255, 0.1);
            transition: all 0.2s ease;
            position: relative;
        }

        .doj-cat-badge:hover {
            background: rgba(255, 255, 255, 0.1);
            transform: translateY(-1px);
        }

        /* Custom Tooltip */
        .doj-cat-badge[data-title]:hover::after {
            content: attr(data-title);
            position: absolute;
            bottom: 110%;
            left: 50%;
            transform: translateX(-50%);
            background: rgba(15, 23, 42, 0.95);
            color: #fff;
            padding: 6px 12px;
            border-radius: 8px;
            font-size: 10px;
            white-space: nowrap;
            z-index: 1000;
            border: 1px solid rgba(255, 255, 255, 0.1);
            box-shadow: 0 4px 15px rgba(0, 0, 0, 0.5);
            backdrop-filter: blur(4px);
            pointer-events: none;
            opacity: 0;
            animation: dojFadeIn 0.2s forwards;
        }

        @keyframes dojFadeIn {
            from { opacity: 0; transform: translate(-50%, 5px); }
            to { opacity: 1; transform: translate(-50%, 0); }
        }

        .doj-cat-badge.video { background: rgba(16, 185, 129, 0.15); border-color: rgba(16, 185, 129, 0.3); }
        .doj-cat-badge.archive { background: rgba(245, 158, 11, 0.15); border-color: rgba(245, 158, 11, 0.3); }
        .doj-cat-badge.image { background: rgba(6, 182, 212, 0.15); border-color: rgba(6, 182, 212, 0.3); }
        .doj-cat-badge.audio { background: rgba(249, 115, 22, 0.15); border-color: rgba(249, 115, 22, 0.3); }
        .doj-cat-badge.document { background: rgba(239, 68, 68, 0.15); border-color: rgba(239, 68, 68, 0.3); }

        .doj-cat-count {
            background: rgba(255, 255, 255, 0.15);
            padding: 1px 6px;
            border-radius: 10px;
            font-size: 10px;
            min-width: 18px;
            text-align: center;
        }

        .doj-tabs {
            display: flex;
            background: rgba(255, 255, 255, 0.05);
            padding: 4px;
            border-radius: 10px;
            margin-bottom: 12px;
            gap: 4px;
        }

        .doj-tab {
            flex: 1;
            text-align: center;
            padding: 8px 4px;
            font-size: 11px;
            font-weight: 600;
            color: rgba(255, 255, 255, 0.6);
            cursor: pointer;
            border-radius: 8px;
            transition: all 0.2s;
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 6px;
        }

        .doj-tab:hover {
            background: rgba(255, 255, 255, 0.1);
            color: #fff;
        }

        .doj-tab.active {
            background: #3b82f6;
            color: #fff;
            box-shadow: 0 2px 4px rgba(0, 0, 0, 0.2);
        }

        .doj-tab.active[data-tab="found"] { background: #eab308; color: #000; }
        .doj-tab.active[data-tab="downloaded"] { background: #10b981; }
        .doj-tab.active[data-tab="detected"] { background: #64748b; }
        .doj-tab.active[data-tab="failed"] { background: #ef4444; }

        .doj-tab-badge {
            background: rgba(0, 0, 0, 0.2);
            padding: 2px 6px;
            border-radius: 10px;
            font-size: 9px;
            min-width: 16px;
        }

        /* Settings Modal Styles */
        #doj-settings-modal {
            display: none;
            position: fixed;
            top: 0; left: 0; right: 0; bottom: 0;
            background: rgba(0, 0, 0, 0.8);
            z-index: 10001;
            align-items: center;
            justify-content: center;
        }
        #doj-settings-modal.active {
            display: flex;
        }

        .doj-settings-body {
            padding: 20px;
            max-height: 70vh;
            overflow-y: auto;
            scrollbar-width: thin;
            scrollbar-color: var(--cin-red) #000;
        }

        .doj-settings-close {
            color: #666;
            background: transparent;
            border: none;
            font-size: 20px;
            cursor: pointer;
            transition: color 0.2s;
        }
        .doj-modal-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 16px 20px;
            border-bottom: 1px solid #222;
        }

        .doj-modal-title {
            color: var(--cin-gold);
            font-family: 'Playfair Display', serif;
            font-size: 16px;
            font-weight: 700;
            margin: 0;
        }



        .doj-ext-grid {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(80px, 1fr));
            gap: 4px;
        }

        .doj-ext-item {
            display: flex;
            align-items: center;
            gap: 4px;
            padding: 4px 8px;
            background: rgba(255, 255, 255, 0.03);
            border: 1px solid rgba(255, 255, 255, 0.06);
            border-radius: 4px;
            font-size: 11px;
            color: #ccc;
            cursor: pointer;
            transition: all 0.2s;
        }
        .doj-ext-item:hover {
            background: rgba(255, 255, 255, 0.08);
            border-color: rgba(255, 255, 255, 0.15);
        }


        .doj-input-group {
            margin-bottom: 12px;
        }

        .doj-input-label {
            display: block;
            font-size: 11px;
            color: #aaa;
            margin-bottom: 4px;
        }

        .doj-input {
            width: 100%;
            padding: 8px 12px;
            background: #111;
            border: 1px solid #333;
            color: #fff;
            font-size: 12px;
            border-radius: 4px;
            box-sizing: border-box;
        }

        .doj-input:focus {
            border-color: var(--cin-gold);
            outline: none;
        }

        /* Alt tag styles */
        .doj-alt-tag {
            display: inline-block;
            padding: 2px 6px;
            margin: 2px;
            background: rgba(139, 92, 246, 0.15);
            border: 1px solid rgba(139, 92, 246, 0.3);
            border-radius: 4px;
            font-size: 9px;
            color: #a78bfa;
            cursor: pointer;
            transition: all 0.2s;
        }

        /* Update Banner */
        .doj-update-banner {
            display: flex;
            align-items: center;
            gap: 10px;
            padding: 10px 16px;
            margin-bottom: 12px;
            background: linear-gradient(135deg, rgba(212, 175, 55, 0.15), rgba(138, 0, 0, 0.1));
            border: 1px solid var(--cin-gold);
            border-radius: 4px;
            font-size: 12px;
            color: var(--cin-gold);
            animation: slideDown 0.3s ease-out;
        }

        .doj-alt-tag:hover {
            background: rgba(139, 92, 246, 0.3);
            border-color: #8b5cf6;
        }
        `;
        (document.body || document.documentElement).appendChild(style);
    }

    // Helper for random delays with enhanced jitter
    const randomDelay = (min = CONFIG.DELAY_MIN || 500, max = CONFIG.DELAY_MAX || 1500) => {
        // Add extra random jitter to make timing unpredictable
        const baseDelay = Math.floor(Math.random() * (max - min) + min);
        const jitterVal = CONFIG.MAX_JITTER || 500; // Default to 500ms max jitter
        const jitter = Math.floor(Math.random() * jitterVal) - (jitterVal / 2);
        const totalDelay = Math.max(200, baseDelay + jitter); // Minimum 200ms

        console.log(`Waiting ${totalDelay}ms before next request...`);
        return new Promise(resolve => setTimeout(resolve, totalDelay));
    };

    // Create main interface
    function createMainInterface() {
        const container = document.createElement('div');
        container.id = 'doj-file-detector';
        container.setAttribute('data-userscript', 'true');

        // Prevent events from bubbling to DOJ site handlers
        const eventTypes = ['click', 'mousedown', 'mouseup', 'mouseover', 'mouseout', 'focus', 'blur', 'keydown', 'keyup'];
        eventTypes.forEach(eventType => {
            // Bubble phase - stops events AFTER they leave children (so buttons still work)
            container.addEventListener(eventType, (e) => {
                e.stopPropagation();
            }, { capture: false });
        });

        container.innerHTML = `
    <div class="doj-header">
                <img src="${typeof GM_getResourceURL !== 'undefined' ? GM_getResourceURL('logo') : 'https://raw.githubusercontent.com/AmericanCitizen/E_video_helper/main/logo.png'}" class="doj-logo" onerror="this.outerHTML='<div style=&quot;width: 80px; height: 80px; border-radius: 16px; background: linear-gradient(135deg, #dc2626, #991b1b); display: flex; align-items: center; justify-content: center; font-size: 40px; border: 2px solid #ef4444; box-shadow: 0 0 20px rgba(239, 68, 68, 0.4);&quot;>🎯</div>'">
                <div class="doj-title-group">
                    <h3 class="doj-title">Epstein File Sniper</h3>
                    <div class="doj-subtitle">v2.3 — Precision Extraction</div>
                    <div style="font-size: 10px; color: #ef4444; margin-top: 4px; opacity: 0.8;">
                        Target Lock: <span id="doj-copy-search" style="color: #fff; background: rgba(0,0,0,0.3); padding: 1px 4px; border-radius: 3px; cursor: pointer; border: 1px solid #ef4444;" title="Click to copy">No Images Produced</span>
                    </div>
                </div>
                <button class="doj-min-btn" id="doj-minimize" title="Minimize/Maximize">_</button>
                <div style="display:flex;">
                     <button class="doj-icon-btn" id="doj-update-check-btn" title="Check for Updates">🔄</button>
                     <button class="doj-icon-btn" id="doj-settings-btn" title="System Settings">⚙️</button>
                     <button class="doj-icon-btn" id="doj-close">×</button>
                </div>
            </div>
            
            <div class="doj-body" id="doj-main-body">
                <div class="doj-tabs">
                    <div class="doj-tab active" data-tab="found">Found <span class="doj-tab-badge" id="tab-count-found">0</span></div>
                    <div class="doj-tab" data-tab="downloaded">Secured <span class="doj-tab-badge" id="tab-count-downloaded">0</span></div>
                    <div class="doj-tab" data-tab="detected">Pending <span class="doj-tab-badge" id="tab-count-detected">0</span></div>
                    <div class="doj-tab" data-tab="failed">Failed <span class="doj-tab-badge" id="tab-count-failed">0</span></div>
                </div>

                <!-- Secured Tab Actions -->
                <div id="doj-tab-actions-downloaded" style="display:none; margin-bottom:10px; justify-content:flex-end;">
                     <button class="doj-btn" id="doj-clear-secured" style="font-size:10px; padding:4px 8px; background:rgba(255,255,255,0.1);">Clear List</button>
                </div>

                <!-- Found/Locked Tab Actions -->
                <div id="doj-tab-actions-found" style="display:none; margin-bottom:10px; justify-content:flex-end; gap: 8px;">
                     <button class="doj-btn" id="doj-rescan-found" style="font-size:10px; padding:4px 8px; background:rgba(234, 179, 8, 0.2); color: #eab308; border: 1px solid rgba(234, 179, 8, 0.3);">Rescan All Found</button>
                </div>

                <!-- Failed/Missed Tab Actions -->
                <div id="doj-tab-actions-failed" style="display:none; margin-bottom:10px; justify-content:flex-end; gap: 8px;">
                     <button class="doj-btn" id="doj-retry-failed" style="font-size:10px; padding:4px 8px; background:rgba(239, 68, 68, 0.2); color: #ef4444; border: 1px solid rgba(239, 68, 68, 0.3);">Retry All Failed</button>
                </div>

                <div style="margin-bottom: 16px;">
                    <div style="font-size: 11px; color: #eab308; margin-bottom: 8px; text-transform: uppercase; letter-spacing: 1px; font-weight: 700;">Extraction Parameters</div>
                    <div id="doj-type-toggles"></div>
                </div>
                
                <div class="doj-btn-group">
                    <button class="doj-btn doj-btn-primary" id="doj-scan" style="flex: 1;">
                        <span>🎯</span> Take Shot
                    </button>
                    <button class="doj-btn" id="doj-rescan-all" style="background: rgba(245, 158, 11, 0.2); color: #fbbf24; flex: 0 0 auto; padding: 0 12px;" title="Reset all files and re-scan everything from scratch">
                        🔄
                    </button>
                    <button class="doj-btn" id="doj-auto-crawl" style="background: #1e40af; flex: 1;">
                        <span>🔭</span> Sweep Mode
                    </button>
                </div>
                
                <div style="margin-top: 8px; margin-bottom: 8px;">
                     <button class="doj-btn" id="doj-clear-history" style="font-size: 11px; background: rgba(239, 68, 68, 0.1); color: #fca5a5; width: 100%; border: 1px solid rgba(239, 68, 68, 0.2);">
                        <span>🗑️</span> Purge Records
                    </button>
                </div>
                <div id="doj-download-group" style="display: none; gap: 8px; margin-bottom: 12px;">
                <button class="doj-btn doj-btn-success" id="doj-download-all" style="flex: 2;">
                    <span>📥</span> Extract All (<span id="doj-pending-count">0</span>)
                </button>
                 <button class="doj-btn" id="doj-download-batch" style="flex: 1; background: #334155; color: white;" title="Extract next batch">
                    <span>📦</span> BATCH <span id="doj-batch-size-label">${CONFIG.BATCH_SIZE}</span>
                </button>
            </div>
                
                <div id="doj-progress-container" style="display: none;">
                    <div class="doj-progress">
                        <div class="doj-progress-bar" id="doj-progress-bar" style="width: 0%"></div>
                    </div>
                    <div class="doj-progress-text" id="doj-progress-text">Scanning...</div>
                </div>
                
                <div class="doj-stats" id="doj-stats" style="display: none;">
                    <div class="doj-stat">
                        <div class="doj-stat-value" id="stat-detected" style="color: #94a3b8;">0</div>
                        <div class="doj-stat-label">Spotted</div>
                    </div>
                    <div class="doj-stat">
                        <div class="doj-stat-value" id="stat-found" style="color: #ef4444;">0</div>
                        <div class="doj-stat-label">Locked</div>
                    </div>
                    <div class="doj-stat">
                        <div class="doj-stat-value" id="stat-downloaded" style="color: #10b981;">0</div>
                        <div class="doj-stat-label">Extracted</div>
                    </div>
                    <div class="doj-stat">
                        <div class="doj-stat-value" id="stat-failed" style="color: #fbbf24;">0</div>
                        <div class="doj-stat-label">Missed</div>
                    </div>
                </div>

                <div class="doj-category-counts" id="doj-category-counts" style="display: none;">
                    <div class="doj-cat-badge video"><span>🎬</span> Video <span class="doj-cat-count" id="cat-count-video">0</span></div>
                    <div class="doj-cat-badge audio"><span>🎵</span> Audio <span class="doj-cat-count" id="cat-count-audio">0</span></div>
                    <div class="doj-cat-badge image"><span>🖼️</span> Image <span class="doj-cat-count" id="cat-count-image">0</span></div>
                    <div class="doj-cat-badge archive"><span>📦</span> Archive <span class="doj-cat-count" id="cat-count-archive">0</span></div>
                    <div class="doj-cat-badge document"><span>📄</span> Document <span class="doj-cat-count" id="cat-count-document">0</span></div>
                    <div class="doj-cat-badge forensic"><span>🔍</span> Forensic <span class="doj-cat-count" id="cat-count-forensic">0</span></div>
                </div>

                <div id="doj-status-bar" style="margin-bottom: 12px; padding: 10px; background: rgba(255,255,255,0.05); border-radius: 8px; font-size: 11px; color: rgba(255,255,255,0.8); display: none; text-align: center; border: 1px dashed rgba(255,255,255,0.1); align-items:center; justify-content:center; gap:8px;">
                     <span id="doj-status-icon" style="font-size: 14px;">ℹ️</span>
                     <span id="doj-status-text">Ready</span>
                </div>
                
                <div class="doj-file-list" id="doj-file-list"></div>
            </div>
`;

        (document.body || document.documentElement).appendChild(container);

        // --- OPTIMIZATION: Event Delegation for File List ---
        const fileListEl = document.getElementById('doj-file-list');
        if (fileListEl) {
            fileListEl.addEventListener('click', (e) => {
                const target = e.target;

                // 1. Handle Buttons (Download / Scan / Rescan)
                const btn = target.closest('button');
                if (btn) {
                    const url = btn.getAttribute('data-url');
                    if (!url) return;

                    const fileData = StateManager.getFile(url);
                    if (!fileData) return;

                    if (btn.classList.contains('download-btn')) {
                        downloadFile(fileData);
                    } else if (btn.classList.contains('rescan-btn')) {
                        scanSingleFile(fileData, true); // Force Deep Scan
                    } else if (btn.classList.contains('scan-btn')) {
                        scanSingleFile(fileData);
                    }
                    return;
                }

                // 2. Handle Alternate Versions (tags)
                const altTag = target.closest('.doj-alt-tag');
                if (altTag) {
                    const altUrl = altTag.getAttribute('data-url');
                    const parentUrl = altTag.getAttribute('data-parent-url'); // Need to pass parent to find original? No, we just need altUrl to download.

                    // But downloadFile expects a fileData object.
                    // We can construct a temporary one or find the parent.
                    // The inline handler used: const altData = { ...fileData, url: altUrl };
                    // So we need the parent fileData to clone metadata.

                    if (parentUrl) {
                        const parentFile = StateManager.getFile(parentUrl);
                        if (parentFile) {
                            const altData = { ...parentFile, url: altUrl };
                            downloadFile(altData);
                        }
                    }
                }
            });
        }

        // Event listeners
        document.getElementById('doj-close').onclick = () => {
            container.style.display = 'none';
        }

        document.getElementById('doj-rescan-all').onclick = () => {
            const stats = StateManager.getStats();
            const count = stats.found + stats.failed + stats.downloaded;

            if (count === 0) {
                alert('No files to re-scan.');
                return;
            }

            if (confirm(`Reset ${count} files (Locked, Missed, Extracted) back to "Spotted" and re-run scan?`)) {
                const allFiles = StateManager.getFiles();
                allFiles.forEach(f => {
                    f.status = 'detected';
                    if (f.originalUrl) f.url = f.originalUrl;
                    delete f.confirmedPdf;
                });
                resolvedLinks.clear();
                StateManager.saveState();
                renderFileList();
                scanCurrentPage();
            }
        }

        document.getElementById('doj-rescan-found').onclick = () => {
            const allFiles = StateManager.getFiles();
            const foundFiles = allFiles.filter(f => f.status === 'found');
            if (foundFiles.length === 0) {
                alert('No "Locked" files to rescan.');
                return;
            }

            if (confirm(`Reset ${foundFiles.length} "Locked" files back to "Spotted" and re-run deep scan?`)) {
                foundFiles.forEach(f => {
                    f.status = 'detected';
                    if (f.originalUrl) f.url = f.originalUrl;
                    delete f.confirmedPdf;
                });
                // Remove from resolved links to allow re-scoping
                foundFiles.forEach(f => {
                    resolvedLinks.delete(getFilenameStem(f.url));
                    if (f.originalUrl) resolvedLinks.delete(getFilenameStem(f.originalUrl));
                });
                StateManager.saveState();
                renderFileList();
                scanCurrentPage(false); // Run a normal scan which picks up detected
            }
        }

        document.getElementById('doj-retry-failed').onclick = () => {
            const allFiles = StateManager.getFiles();
            const failedFiles = allFiles.filter(f => f.status === 'failed');
            if (failedFiles.length === 0) {
                alert('No "Missed" files to retry.');
                return;
            }

            if (confirm(`Reset ${failedFiles.length} "Missed" files back to "Spotted" and retry?`)) {
                failedFiles.forEach(f => f.status = 'detected');
                StateManager.saveState();
                renderFileList();
                scanCurrentPage(false);
            }
        }

        document.getElementById('doj-settings-btn').onclick = () => {
            openSettingsModal();
        }

        document.getElementById('doj-update-check-btn').onclick = () => {
            checkForUpdates(container, true); // Manual check
        };

        document.getElementById('doj-scan').onclick = () => {
            scanCurrentPage(false);
        };



        // Minimize Logic
        const minBtn = document.getElementById('doj-minimize');
        const mainBody = document.getElementById('doj-main-body');
        let isMinimized = true;

        // Init Minimized State
        mainBody.style.display = 'none';
        minBtn.textContent = '□';
        container.style.height = 'auto';

        minBtn.onclick = () => {
            isMinimized = !isMinimized;
            mainBody.style.display = isMinimized ? 'none' : 'block';
            minBtn.textContent = isMinimized ? '□' : '_';
            container.style.height = isMinimized ? 'auto' : ''; // Reset height
        };

        // Clear Secured Logic
        document.getElementById('doj-clear-secured').onclick = () => {
            if (confirm('Remove all secured items from the list? (Files remain on disk)')) {
                // We don't delete them from state, just change their status to separate 'archived' or just remove from list view?
                // Ideally, we just filter them out of view or delete them. 
                // Let's delete them to keep it clean.
                StateManager.clearStats('downloaded');
                renderFileList();
                updateStats();
            }
        };

        document.getElementById('doj-clear-history').onclick = () => {
            if (confirm('Are you sure you want to clear all history?')) {
                StateManager.clear();
            }
        };

        document.getElementById('doj-download-all').onclick = () => {
            downloadAllFiles();
        };

        document.getElementById('doj-download-batch').onclick = () => {
            downloadBatch(CONFIG.BATCH_SIZE);
        };

        // Add copy functionality without inline handler
        const copySearchBtn = document.getElementById('doj-copy-search');
        if (copySearchBtn) {
            copySearchBtn.onclick = (e) => {
                e.preventDefault();
                e.stopPropagation();
                e.stopImmediatePropagation();
                navigator.clipboard.writeText('No Images Produced');
                copySearchBtn.style.borderColor = '#10b981';
                setTimeout(() => copySearchBtn.style.borderColor = 'rgba(255,255,255,0.1)', 500);
            };
        }

        // Create type toggles
        const typeContainer = document.getElementById('doj-type-toggles');
        Object.keys(FILE_EXTENSIONS).forEach(type => {
            const div = document.createElement('div');
            div.className = 'doj-toggle small';

            // Format example extensions
            const examples = FILE_EXTENSIONS[type].slice(0, 3).join(', ') + (FILE_EXTENSIONS[type].length > 3 ? '...' : '');

            div.innerHTML = `
    <span class="doj-toggle-label">
                    <div style="display:flex; align-items:center; gap:8px;">
                        <span>${getCategoryIcon(type)}</span> 
                        ${type.charAt(0).toUpperCase() + type.slice(1)}s
                    </div>
                    <div class="doj-toggle-sub">${examples}</div>
                </span>
    <label class="doj-switch" style="transform: scale(0.8);">
        <input type="checkbox" data-type="${type}" ${CONFIG.ENABLED_TYPES[type] ? 'checked' : ''}>
            <span class="doj-slider"></span>
    </label>
`;

            div.querySelector('input').onchange = (e) => {
                CONFIG.ENABLED_TYPES[type] = e.target.checked;
                saveConfig();
            };

            typeContainer.appendChild(div);
        });

        // Tab click handlers
        const tabs = container.querySelectorAll('.doj-tab');
        tabs.forEach(tab => {
            tab.onclick = () => {
                // Update UI
                tabs.forEach(t => t.classList.remove('active'));
                tab.classList.add('active');

                // Update State
                activeTab = tab.getAttribute('data-tab');

                // Update UI based on tab
                const actionsFound = container.querySelector('#doj-tab-actions-found');
                const actionsFailed = container.querySelector('#doj-tab-actions-failed');
                const actionsDownloaded = container.querySelector('#doj-tab-actions-downloaded');

                if (actionsFound) actionsFound.style.display = (activeTab === 'found') ? 'flex' : 'none';
                if (actionsFailed) actionsFailed.style.display = (activeTab === 'failed') ? 'flex' : 'none';
                if (actionsDownloaded) actionsDownloaded.style.display = (activeTab === 'downloaded') ? 'flex' : 'none';

                // Re-render
                renderFileList();
            };
        });

        // Silent update check on startup
        checkForUpdates(container);

        return container;
    }

    // --- AUTO-UPDATE CHECK ---
    function compareVersions(local, remote) {
        const l = local.split('.').map(Number);
        const r = remote.split('.').map(Number);
        for (let i = 0; i < Math.max(l.length, r.length); i++) {
            const lv = l[i] || 0;
            const rv = r[i] || 0;
            if (rv > lv) return 1;   // remote is newer
            if (rv < lv) return -1;  // local is newer
        }
        return 0; // equal
    }

    function checkForUpdates(container, manual = false) {
        if (manual) setStatus('Checking for updates...', 'info');
        try {
            GM_xmlhttpRequest({
                method: 'GET',
                url: UPDATE_URL + '?t=' + Date.now(), // cache-bust
                headers: { 'Cache-Control': 'no-cache' },
                onload: function (response) {
                    try {
                        const match = response.responseText.match(/@version\s+([\d.]+)/);
                        if (!match) {
                            console.log('[Update Check] Could not parse remote version.');
                            return;
                        }
                        const remoteVersion = match[1];
                        console.log(`[Update Check] Local: v${SCRIPT_VERSION}, Remote: v${remoteVersion}`);

                        const comparison = compareVersions(SCRIPT_VERSION, remoteVersion);

                        if (comparison === 1) {
                            // Remote is newer
                            showUpdateBanner(container, remoteVersion);
                            if (manual) setStatus(`Update v${remoteVersion} available!`, 'success');
                        } else if (comparison === -1) {
                            // Local is newer (Dev version)
                            console.log('[Update Check] Local version is ahead of remote.');
                            if (manual) {
                                alert(`🧪 Development Version Detected\n\nLocal: v${SCRIPT_VERSION}\nRemote: v${remoteVersion}\n\nYou are ahead of the public release.`);
                                setStatus('Dev version ahead of remote.', 'info');
                            }
                        } else {
                            // Equal
                            console.log('[Update Check] You are up to date.');
                            if (manual) {
                                alert(`✅ You are up to date!\n\nLocal: v${SCRIPT_VERSION}\nRemote: v${remoteVersion}`);
                                setStatus('System is up to date.', 'success');
                            }
                        }
                    } catch (e) {
                        console.warn('[Update Check] Parse error:', e);
                    }
                },
                onerror: function () {
                    console.warn('[Update Check] Network error, skipping.');
                }
            });
        } catch (e) {
            console.warn('[Update Check] Failed:', e);
        }
    }

    function showUpdateBanner(container, remoteVersion) {
        const banner = document.createElement('div');
        banner.className = 'doj-update-banner';
        banner.innerHTML = `
            <div style="flex:1;">
                <strong>🚀 Update Available!</strong>
                <span style="opacity:0.8;">v${SCRIPT_VERSION} → v${remoteVersion}</span>
            </div>
            <button id="doj-update-btn" class="doj-btn" style="padding:4px 12px; background:var(--cin-gold); color:#000; border:none; font-size:10px; font-weight:700;">UPDATE</button>
            <button id="doj-dismiss-update" class="doj-btn" style="padding:4px 8px; background:transparent; color:#888; border:1px solid #444; font-size:10px;">✕</button>
        `;

        // Insert at top of body area
        const body = container.querySelector('.doj-body');
        if (body) {
            body.insertBefore(banner, body.firstChild);
        } else {
            container.appendChild(banner);
        }

        document.getElementById('doj-update-btn').onclick = () => {
            window.open(UPDATE_URL, '_blank');
        };
        document.getElementById('doj-dismiss-update').onclick = () => {
            banner.remove();
        };
    }

    // Create Settings Modal
    function createSettingsModal() {
        const modal = document.createElement('div');
        modal.id = 'doj-settings-modal';
        modal.setAttribute('data-userscript', 'true');

        // Prevent events from bubbling to DOJ site handlers
        const eventTypes = ['click', 'mousedown', 'mouseup', 'mouseover', 'mouseout', 'focus', 'blur', 'keydown', 'keyup'];
        eventTypes.forEach(eventType => {
            // Bubble phase - stops events AFTER they leave children
            modal.addEventListener(eventType, (e) => {
                e.stopPropagation();
            }, { capture: false });
        });
        modal.innerHTML = `
    <div class="doj-settings-content">
                <div class="doj-modal-header">
                    <h3 class="doj-modal-title">⚙️ Advanced Settings</h3>
                    <button class="doj-settings-close" id="doj-settings-close">×</button>
                </div>
                <div class="doj-settings-body">
                    <div style="font-size:11px; text-transform:uppercase; color:rgba(255,255,255,0.4); margin-bottom:12px; font-weight:600;">Anti-Bot Protection Settings</div>
                    
                    <div class="doj-toggle" style="margin-bottom: 12px;">
                        <span class="doj-toggle-label">
                            <div>🛡️ Stealth Mode (Recommended)</div>
                            <div class="doj-toggle-sub">Realistic headers, GET with Range, cookie handling</div>
                        </span>
                        <label class="doj-switch">
                            <input type="checkbox" id="doj-set-stealth" ${CONFIG.USE_STEALTH_MODE ? 'checked' : ''}>
                            <span class="doj-slider"></span>
                        </label>
                    </div>
                    
                    <div class="doj-toggle" style="margin-bottom: 12px;">
                        <span class="doj-toggle-label">
                            <div>🎲 Randomize Order</div>
                            <div class="doj-toggle-sub">Shuffle links/extensions to avoid patterns</div>
                        </span>
                        <label class="doj-switch">
                            <input type="checkbox" id="doj-set-randomize" ${CONFIG.RANDOMIZE_ORDER ? 'checked' : ''}>
                            <span class="doj-slider"></span>
                        </label>
                    </div>

                    <div class="doj-toggle" style="margin-bottom: 12px;">
                        <span class="doj-toggle-label">
                            <div style="color:var(--cin-gold);">🎬 Prioritize Media (Deep Scan)</div>
                            <div class="doj-toggle-sub">If a PDF is found, IGNORE it and keep scanning for hidden video/audio files. (Slower)</div>
                        </span>
                        <label class="doj-switch">
                            <input type="checkbox" id="doj-set-prioritize" ${CONFIG.PRIORITIZE_MEDIA ? 'checked' : ''}>
                            <span class="doj-slider"></span>
                        </label>
                    </div>
                    
                    <div class="doj-input-group">
                        <label class="doj-input-label">⏱️ Minimum Request Delay (ms) - Recommended: 2000-5000</label>
                        <input type="number" class="doj-input" id="doj-set-min" value="${CONFIG.DELAY_MIN}" step="100">
                    </div>
                    <div class="doj-input-group">
                        <label class="doj-input-label">⏱️ Maximum Request Delay (ms) - Recommended: 5000-10000</label>
                        <input type="number" class="doj-input" id="doj-set-max" value="${CONFIG.DELAY_MAX}" step="100">
                    </div>
                    <div class="doj-input-group">
                        <label class="doj-input-label">🎯 Additional Random Jitter (ms)</label>
                        <input type="number" class="doj-input" id="doj-set-jitter" value="${CONFIG.MAX_JITTER || 2000}" step="100">
                    </div>
                    <div class="doj-input-group">
                        <label class="doj-input-label">🚀 Concurrent Requests (Speed) - Recommended: 1-3</label>
                        <input type="number" class="doj-input" id="doj-set-concurrent" value="${CONFIG.MAX_CONCURRENT || 1}" step="1" min="1" max="10">
                    </div>
                    
                    <div style="background: rgba(139, 92, 246, 0.1); border: 1px solid rgba(139, 92, 246, 0.3); border-radius: 8px; padding: 12px; margin: 12px 0; font-size: 11px; color: rgba(255,255,255,0.7);">
                        <strong style="color: #8b5cf6;">💡 Anti-Akamai Tips:</strong><br>
                        • Higher delays = better success rate<br>
                        • Always enable Stealth Mode<br>
                        • Scan fewer file types at once<br>
                        • If blocked, wait 5-10 minutes
                    </div>
                    
                    <div style="margin: 20px 0 12px 0; border-top: 1px solid rgba(255,255,255,0.1); padding-top: 20px;">
                        <div style="font-size:11px; text-transform:uppercase; color:rgba(255,255,255,0.4); margin-bottom:12px; font-weight:600;">Granular Extension Control</div>
                        <div id="doj-settings-exts"></div>
                    </div>

                    <div style="margin: 20px 0 12px 0; border-top: 1px solid rgba(255,255,255,0.1); padding-top: 20px;">
                        <div style="font-size:11px; text-transform:uppercase; color:rgba(255,255,255,0.4); margin-bottom:12px; font-weight:600;">Sweep Mode Settings</div>
                        <div class="doj-input-group">
                            <label class="doj-input-label">⏩ Sweep Delay per Page (ms)</label>
                            <input type="number" class="doj-input" id="doj-set-crawl-delay" value="${CONFIG.AUTO_CRAWL_DELAY || 2000}" step="100">
                        </div>
                        <div class="doj-input-group">
                            <label class="doj-input-label">⏳ Page Load Wait Time (ms)</label>
                            <input type="number" class="doj-input" id="doj-set-page-delay" value="${CONFIG.PAGE_LOAD_DELAY || 1000}" step="100">
                        </div>
                        <div class="doj-input-group">
                            <label class="doj-input-label">📦 Batch Download Size</label>
                            <input type="number" class="doj-input" id="doj-set-batch-size" value="${CONFIG.BATCH_SIZE || 25}" step="1" min="1" max="1000">
                        </div>
                        <div class="doj-input-group">
                            <label class="doj-input-label">🛑 Safety Batch Limit (Download All)</label>
                            <input type="number" class="doj-input" id="doj-set-safety-limit" value="${CONFIG.SAFETY_BATCH_LIMIT || 100}" step="10" min="10">
                        </div>
                        <div class="doj-input-group">
                            <label class="doj-input-label">💾 Max Blob Size (MB) - RAM Dependent</label>
                            <input type="number" class="doj-input" id="doj-set-blob-limit" value="${CONFIG.MAX_BLOB_SIZE_MB || 500}" step="50" min="50">
                        </div>
                    </div>

                    <div style="margin: 20px 0 12px 0; border-top: 1px solid rgba(255,255,255,0.1); padding-top: 20px;">
                        <div style="font-size:11px; text-transform:uppercase; color:rgba(255,255,255,0.4); margin-bottom:12px; font-weight:600;">Data Management</div>
                        <div style="display:flex; gap:10px;">
                            <button class="doj-btn" id="doj-export-btn" style="background: #3b82f6;">📤 Export Links</button>
                            <button class="doj-btn" id="doj-import-btn" style="background: #10b981;">📥 Import Links</button>
                            <input type="file" id="doj-import-input" style="display:none" accept=".json">
                        </div>
                    </div>

                    <div style="margin: 20px 0 12px 0; border-top: 1px solid rgba(255,255,255,0.1); padding-top: 20px;">
                        <div style="font-size:11px; text-transform:uppercase; color:rgba(255,255,255,0.4); margin-bottom:12px; font-weight:600;">Problem Resolution</div>
                        <div style="display:flex; gap:10px;">
                            <button class="doj-btn" id="doj-rescan-pdfs" style="background: #ef4444; width: 100%;">
                                ⚠️ Rescan All Found PDFs (Fix Soft 404s)
                            </button>
                        </div>
                        <div style="font-size:10px; color:rgba(255,255,255,0.5); margin-top:6px;">
                            Use this if you have files incorrectly identified as PDFs. It will reset them so they can be re-checked.
                        </div>
                    </div>
                </div>
                <div style="padding-top:16px; display:flex; gap:10px;">
                     <button class="doj-btn doj-btn-primary" id="doj-settings-save">Save Settings</button>
                     <button class="doj-btn" id="doj-settings-reset" style="background: rgba(255,255,255,0.1);">Reset Defaults</button>
                </div>
            </div>
         `;
        document.body.appendChild(modal);

        // Event listeners
        document.getElementById('doj-settings-close').onclick = () => {
            modal.classList.remove('active');
            setTimeout(() => modal.style.display = 'none', 300);
        }

        document.getElementById('doj-settings-save').onclick = () => {
            CONFIG.DELAY_MIN = parseInt(document.getElementById('doj-set-min').value) || 2000;
            CONFIG.DELAY_MAX = parseInt(document.getElementById('doj-set-max').value) || 5000;
            CONFIG.MAX_JITTER = parseInt(document.getElementById('doj-set-jitter').value) || 2000;
            CONFIG.AUTO_CRAWL_DELAY = parseInt(document.getElementById('doj-set-crawl-delay').value) || 2000;
            CONFIG.PAGE_LOAD_DELAY = parseInt(document.getElementById('doj-set-page-delay').value) || 1000;
            CONFIG.BATCH_SIZE = parseInt(document.getElementById('doj-set-batch-size').value) || 25;
            CONFIG.SAFETY_BATCH_LIMIT = parseInt(document.getElementById('doj-set-safety-limit').value) || 100;
            CONFIG.MAX_BLOB_SIZE_MB = parseInt(document.getElementById('doj-set-blob-limit').value) || 500;
            CONFIG.USE_STEALTH_MODE = document.getElementById('doj-set-stealth').checked;
            CONFIG.RANDOMIZE_ORDER = document.getElementById('doj-set-randomize').checked;
            CONFIG.PRIORITIZE_MEDIA = document.getElementById('doj-set-prioritize').checked;
            CONFIG.MAX_CONCURRENT = parseInt(document.getElementById('doj-set-concurrent').value) || 1;
            saveConfig();
            updateStats(); // Refresh batch button label
            modal.classList.remove('active');
            setTimeout(() => modal.style.display = 'none', 300);
            alert('Settings Saved!\n\nStealth Mode: ' + (CONFIG.USE_STEALTH_MODE ? 'ON' : 'OFF') + '\nBatch Size: ' + CONFIG.BATCH_SIZE + '\nConcurrent: ' + CONFIG.MAX_CONCURRENT);
        }

        document.getElementById('doj-settings-reset').onclick = () => {
            if (confirm('Are you sure you want to reset all settings to default?')) {
                CONFIG = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
                saveConfig();
                openSettingsModal(); // Refresh UI
            }
        };

        // Export/Import Listeners
        document.getElementById('doj-export-btn').onclick = () => StateManager.exportState();

        const importInput = document.getElementById('doj-import-input');
        document.getElementById('doj-import-btn').onclick = () => importInput.click();
        importInput.onchange = (e) => {
            if (e.target.files.length > 0) {
                StateManager.importState(e.target.files[0]);
                e.target.value = ''; // Reset
            }
        };

        return modal;
    }

    function openSettingsModal() {
        let modal = document.getElementById('doj-settings-modal');
        if (!modal) modal = createSettingsModal();

        // Re-attach listener for rescan button (safe to do since we just created or retrieved modal)
        const rescanBtn = document.getElementById('doj-rescan-pdfs');
        if (rescanBtn) {
            rescanBtn.onclick = () => {
                if (confirm('This will RESET all found PDF files to "Pending" so they can be re-scanned.\n\nUse this to fix files that were incorrectly identified as PDFs.\n\nContinue?')) {
                    const allFiles = StateManager.getFiles();
                    let count = 0;
                    allFiles.forEach(f => {
                        // Target only FOUND files that are marked as PDF
                        if (f.status === 'found' && f.extension === '.pdf') {
                            f.status = 'detected';
                            // Clear resolved links for these stems so scanner picks them up
                            const stem = getFilenameStem(f.url);
                            resolvedLinks.delete(stem);
                            if (f.originalUrl) resolvedLinks.delete(getFilenameStem(f.originalUrl));
                            count++;
                        }
                    });

                    if (count > 0) {
                        StateManager.saveState();
                        renderFileList();
                        updateStats();
                        alert(`Successfully reset ${count} PDF files.\n\nPlease click "Scan Page" to re-check them with the new strict validation.`);
                        modal.classList.remove('active');
                        setTimeout(() => modal.style.display = 'none', 300);
                    } else {
                        alert('No "Found" PDF files were found to reset.');
                    }
                }
            };
        }

        // Populate Granular Extensions
        const container = document.getElementById('doj-settings-exts');
        container.innerHTML = '';

        Object.keys(FILE_EXTENSIONS).forEach(type => {
            const exts = FILE_EXTENSIONS[type];
            const group = document.createElement('div');
            group.style.marginBottom = '16px';

            // Header with Top 5 Button
            const header = document.createElement('div');
            header.style.cssText = 'display:flex; align-items:center; justify-content:space-between; margin-bottom:4px;';

            header.innerHTML = `
                <div style="font-weight:600; font-size:12px; color:#fff; display:flex; align-items:center; gap:8px;">
                    ${getCategoryIcon(type)} ${type.toUpperCase()}
                </div>
                <div style="display:flex; gap:8px;">
                    <button class="doj-btn doj-btn-secondary" id="btn-top5-${type}" style="padding: 2px 8px; font-size: 10px; height: auto;" title="Select only the 5 most popular formats">
                        Top 5 Only
                    </button>
                    <button class="doj-btn doj-btn-secondary" id="btn-all-${type}" style="padding: 2px 8px; font-size: 10px; height: auto;" title="Enable all formats in this category">
                        Enable All
                    </button>
                </div>
            `;

            // Top 5 Click Handler
            header.querySelector(`#btn-top5-${type}`).onclick = () => {
                const top5 = TOP_EXTENSIONS[type] || [];
                // Update Config
                exts.forEach(ext => {
                    CONFIG.ENABLED_EXTENSIONS[ext] = top5.includes(ext);
                });

                // Update UI Checkboxes
                const inputs = group.querySelectorAll('input[type="checkbox"]');
                inputs.forEach((input) => {
                    const ext = input.getAttribute('data-ext');
                    input.checked = top5.includes(ext);
                });
                saveConfig();
            };

            // Enable All Click Handler
            header.querySelector(`#btn-all-${type}`).onclick = () => {
                // Update Config to ALL TRUE
                exts.forEach(ext => {
                    CONFIG.ENABLED_EXTENSIONS[ext] = true;
                });

                // Update UI Checkboxes
                const inputs = group.querySelectorAll('input[type="checkbox"]');
                inputs.forEach((input) => {
                    input.checked = true;
                });
                saveConfig();
            };

            group.appendChild(header);

            const grid = document.createElement('div');
            grid.className = 'doj-ext-grid';

            exts.forEach(ext => {
                const label = document.createElement('label');
                label.className = 'doj-ext-item';
                const isChecked = CONFIG.ENABLED_EXTENSIONS[ext] !== false; // Default true
                label.innerHTML = `
                    <input type="checkbox" data-ext="${ext}" style="accent-color:#8b5cf6;" ${isChecked ? 'checked' : ''}>
                    ${ext}
                 `;
                label.querySelector('input').onchange = (e) => {
                    CONFIG.ENABLED_EXTENSIONS[ext] = e.target.checked;
                    saveConfig();
                };
                grid.appendChild(label);
            });

            group.appendChild(grid);
            container.appendChild(group);
        });

        document.getElementById('doj-set-min').value = CONFIG.DELAY_MIN;
        document.getElementById('doj-set-max').value = CONFIG.DELAY_MAX;
        document.getElementById('doj-set-jitter').value = CONFIG.MAX_JITTER || 2000;
        document.getElementById('doj-set-crawl-delay').value = CONFIG.AUTO_CRAWL_DELAY || 2000;
        document.getElementById('doj-set-page-delay').value = CONFIG.PAGE_LOAD_DELAY || 1000;
        document.getElementById('doj-set-batch-size').value = CONFIG.BATCH_SIZE || 25;
        document.getElementById('doj-set-blob-limit').value = CONFIG.MAX_BLOB_SIZE_MB || 500;
        document.getElementById('doj-set-safety-limit').value = CONFIG.SAFETY_BATCH_LIMIT || 100;
        document.getElementById('doj-set-stealth').checked = CONFIG.USE_STEALTH_MODE !== false; // Default true
        document.getElementById('doj-set-randomize').checked = CONFIG.RANDOMIZE_ORDER !== false; // Default true
        document.getElementById('doj-set-prioritize').checked = CONFIG.PRIORITIZE_MEDIA === true; // Default false

        modal.style.display = 'flex';
        // force reflow
        modal.offsetHeight;
        modal.classList.add('active');
    }



    // Get file category
    function getFileCategory(extension) {
        for (const [category, extensions] of Object.entries(FILE_EXTENSIONS)) {
            if (extensions.includes(extension)) {
                return category;
            }
        }
        return 'unknown';
    }

    // Get icon for category
    function getCategoryIcon(category) {
        const icons = {
            video: '🎬',
            archive: '📦',
            image: '🖼️',
            audio: '🎵',
            document: '📄',
            forensic: '🧬'
        };
        return icons[category] || '📁';
    }

    // Helper to sanitize ID
    function sanitizeId(url) {
        return url.replace(/[^a-zA-Z0-9]/g, '');
    }

    // Render the list of files
    function renderFileList() {
        const fileList = document.getElementById('doj-file-list');
        if (!fileList) return;

        fileList.innerHTML = '';
        const allFiles = StateManager.getFiles();

        // Filter by Active Tab
        const files = allFiles.filter(f => f.status === activeTab);

        if (files.length === 0) {
            fileList.innerHTML = `<div style="padding:20px; text-align:center; color:rgba(255,255,255,0.3);">No ${activeTab} files</div>`;
            return;
        }

        const fragment = document.createDocumentFragment();

        files.forEach(fileData => {
            const filename = fileData.url.split('/').pop();
            const isDetected = fileData.status === 'detected';
            // Generate stable ID for highlighting using originalUrl if available
            const stableUrl = fileData.originalUrl || fileData.url;
            const safeId = sanitizeId(stableUrl);

            const fileItem = document.createElement('div');
            fileItem.className = 'doj-file-item';
            fileItem.id = `file-item-${safeId}`;

            // Persist Scanning State (Check both current and original URL)
            if (scanningUrls.has(fileData.url) || scanningUrls.has(fileData.originalUrl)) {
                fileItem.classList.add('scanning');
            }

            // Large file class
            if (fileData.isTooLarge) {
                fileItem.classList.add('too-large');
            }

            // Opacity for detected items
            if (isDetected) fileItem.style.opacity = '0.7';

            let actionButtons = '';
            // Data attribute for event delegation
            const dataUrlAttr = `data-url="${fileData.url}"`;

            if (!isDetected) {
                if (fileData.status === 'downloaded') {
                    actionButtons += `<button class="doj-file-dl" style="background: rgba(16, 185, 129, 0.2); color: #10b981; cursor: default;" disabled>✅ Downloaded</button>`;
                } else {
                    actionButtons += `<button class="doj-file-dl download-btn" title="Download" ${dataUrlAttr}>⬇️</button>`;
                }

                // Add Rescan / Deep Scan button for found files
                actionButtons += `<button class="doj-file-dl rescan-btn" style="background: rgba(59, 130, 246, 0.3);" title="Deep Scan: Check for other formats" ${dataUrlAttr}>🔄</button>`;

            } else {
                // Manual Scan Button
                actionButtons += `<button class="doj-file-dl scan-btn" style="background: rgba(59, 130, 246, 0.3);" title="Scan This File Now" ${dataUrlAttr}>🔍</button>`;
                actionButtons += `<span style="font-size:10px; opacity:0.5; margin-left:6px;">WAITING</span>`;
            }

            let alternatesHtml = '';
            if (fileData.alternates && fileData.alternates.length > 0) {
                alternatesHtml = `<div style="margin-top:4px; font-size:10px; opacity:0.8; padding-left:24px;">`;
                alternatesHtml += `<span style="opacity:0.5; margin-right:4px;">Versions:</span>`;
                fileData.alternates.forEach(alt => {
                    // Add parent URL for reconstruction
                    alternatesHtml += `<span class="doj-alt-tag" data-url="${alt.url}" data-parent-url="${fileData.url}" style="cursor:pointer; background:rgba(255,255,255,0.1); padding:2px 6px; border-radius:4px; margin-right:4px;">${alt.type.toUpperCase()} ${(alt.size / 1024 / 1024).toFixed(1)}MB</span>`;
                });
                alternatesHtml += `</div>`;
            }

            fileItem.innerHTML = `
                <div class="doj-file-icon ${fileData.category}" style="${isDetected ? 'filter:grayscale(1);' : ''}">${getCategoryIcon(fileData.category)}</div>
                <div class="doj-file-info">
                    <div class="doj-file-name" title="${filename}">
                        ${filename}
                        ${fileData.isTooLarge ? '<span class="doj-unstable-badge">⚠️ UNSTABLE</span>' : ''}
                    </div>
                    <div class="doj-file-size" style="${fileData.isTooLarge ? 'color: #f59e0b; font-weight: bold;' : ''}">
                        ${isDetected ? 'Pending Scan' : (fileData.size / 1024 / 1024).toFixed(1) + ' MB'} • ${fileData.category}
                        ${fileData.isTooLarge ? ' • <span style="color:#ef4444">MANUAL DL RECOMMENDED</span>' : ''}
                    </div>
                    ${alternatesHtml}
                </div>
                ${actionButtons}
            `;

            fragment.appendChild(fileItem);
        });

        fileList.appendChild(fragment);


        // Ensure stats are always in sync with what's rendered/available
        updateStats();
    }

    // Manual Single File Scan
    async function scanSingleFile(fileEntry, forceDeep = false) {
        // Enforce Serial Execution via Queue
        globalScanQueue = globalScanQueue.then(async () => {
            const pdfUrl = fileEntry.url;
            console.log(`Manual Scan started for: ${pdfUrl} (Deep: ${forceDeep})`);

            setStatus(`Scanning single file: ${getFilenameStem(pdfUrl)}...`, 'info');

            // Track Scanning State
            scanningUrls.add(pdfUrl);

            // Highlight
            const itemElement = document.getElementById(`file-item-${sanitizeId(pdfUrl)}`);
            if (itemElement) itemElement.classList.add('scanning');

            let matches = [];
            let fallbackPdfResult = null;

            // Phase 1: Magic byte probe — 1 Range request reveals the true file type instantly.
            if (!forceDeep) {
                setStatus('Probing file signature...', 'info');
                const sigResult = await snipeFileType(pdfUrl);
                if (sigResult) {
                    console.log(`SIGNATURE MATCH: ${sigResult.url} → ${sigResult.extension}`);

                    // NEW: PRIORITIZE MEDIA LOGIC
                    // If we found a document (PDF) but user wants to prioritize media -> Ignore it (for now) and Force Deep Scan
                    if (CONFIG.PRIORITIZE_MEDIA && sigResult.category === 'document') {
                        console.log('Prioritize Media ENABLED: Found Document, but forcing search for better formats...');
                        setStatus('PDF found, but probing for video (Prioritize Media)...', 'warning');
                        fallbackPdfResult = sigResult; // Store for fallback
                    } else {
                        matches.push({
                            url: sigResult.url, type: sigResult.type,
                            size: sigResult.size, category: sigResult.category,
                            extension: sigResult.extension
                        });
                    }
                }
            }

            // Phase 2: Extension loop fallback (signature unrecognized OR deep scan for alternates).
            if (matches.length === 0 || forceDeep) {
                const categoryOrder = Object.keys(FILE_EXTENSIONS).filter(cat => CONFIG.ENABLED_TYPES[cat]);
                let orderedExtensions = [];
                categoryOrder.forEach(category => {
                    const categoryExts = FILE_EXTENSIONS[category].filter(ext => CONFIG.ENABLED_EXTENSIONS[ext] !== false);
                    orderedExtensions.push(...categoryExts);
                });

                for (let i = 0; i < orderedExtensions.length; i++) {
                    const extension = orderedExtensions[i];
                    if (matches.some(m => m.extension === extension)) continue;

                    setStatus(`Checking ${extension}...`, 'info');
                    const fileData = await testFileUrl(pdfUrl, extension);

                    if (fileData.success) {
                        console.log(`EXTENSION MATCH: ${fileData.url}`);
                        matches.push({
                            url: fileData.url, type: fileData.type,
                            size: fileData.size, category: fileData.category,
                            extension: extension
                        });
                        if (!forceDeep) break;
                    } else if (fileData.reason === 'blocked') {
                        setStatus('SCAN BLOCKED (403/429).', 'error');
                        alert('DOJ Site is blocking requests.');
                        break;
                    }

                    await randomDelay(200, 500);
                }
            }

            // Phase 3: Fallback Restoration
            // If Phase 2 found nothing (e.g. no video), but we had a valid PDF from Phase 1, use it.
            if (matches.length === 0 && fallbackPdfResult) {
                console.log(`Deep scan yielded no media. Falling back to found PDF: ${fallbackPdfResult.url}`);
                setStatus('No hidden media found. Reverting to PDF.', 'info');
                matches.push({
                    url: fallbackPdfResult.url, type: fallbackPdfResult.type,
                    size: fallbackPdfResult.size, category: fallbackPdfResult.category,
                    extension: fallbackPdfResult.extension
                });
            } else if (matches.length === 0 && !forceDeep) {
                // LAST RESORT: If everything failed, try one quick probe of the .pdf URL without Range request
                // This catches cases where the server blocks Range probes but allows regular ones.
                console.log('Total scan failure. Running final simple-probe of original URL...');
                try {
                    const finalResp = await fetchWithRetry(pdfUrl, { method: 'HEAD' });
                    const contentType = finalResp.headers.get('content-type') || '';
                    if (contentType.includes('pdf')) {
                        console.log('Final probe confirmed PDF via Content-Type header.');
                        matches.push({
                            url: pdfUrl, type: 'application/pdf', size: null,
                            category: 'document', extension: '.pdf'
                        });
                    }
                } catch (e) {
                    console.error('Final fallback probe failed.', e);
                }
            }

            // Cleanup Scanning State
            scanningUrls.delete(pdfUrl);

            // Re-query element to remove class (DOM might have been rebuilt)
            const finalElement = document.getElementById(`file-item-${sanitizeId(fileEntry.originalUrl || fileEntry.url)}`);
            if (finalElement) finalElement.classList.remove('scanning');

            if (matches.length > 0) {
                // Update Entry with primary match (first one found)
                const primary = matches[0];

                if (!fileEntry.originalUrl) fileEntry.originalUrl = fileEntry.url;
                fileEntry.url = primary.url;
                fileEntry.type = primary.type;
                fileEntry.size = primary.size;
                fileEntry.category = primary.category;
                fileEntry.status = 'found';
                fileEntry.extension = primary.extension;

                // Store alternates if any
                if (matches.length > 1) {
                    fileEntry.alternates = matches.slice(1).map(m => ({
                        url: m.url,
                        type: m.extension,
                        size: m.size
                    }));
                }

                StateManager.saveState();
                renderFileList();
                updateStats();

                const linkElement = document.querySelector(`a[href="${pdfUrl}"]`);
                if (linkElement) injectInlineResult(linkElement, fileEntry);

                setStatus(`Found: ${matches.length} file(s)`, 'success');
            } else {
                if (itemElement) itemElement.classList.remove('scanning');
                setStatus('Scan finished. No matching file found.', 'error');
                setTimeout(() => setStatus('Ready'), 3000);
            }

        }).catch(err => console.error("Queue Error:", err));

        return globalScanQueue;
    }
    // Download a single file
    function downloadFile(fileData) {
        const url = fileData.url;
        const filename = generateDownloadFilename(fileData);
        const extension = filename.split('.').pop().toLowerCase();

        console.log(`Starting extraction for: ${filename} from ${url}`);

        // FINAL SANITY GUARD — block .pdf URLs unless magic bytes confirmed it IS a real PDF.
        if (/\.pdf($|\?|#)/i.test(url) && !fileData.confirmedPdf) {
            console.error(`BLOCKING unconfirmed PDF download: ${url}`);
            setStatus(`Error: Attempted to download unconfirmed PDF!`, 'error');
            fileData.status = 'detected'; // Reset it
            StateManager.saveState();
            renderFileList();
            return;
        }

        setStatus(`Securing: ${filename}`, 'info');

        // FORCE FORENSIC MODE (Blob) - Bypasses CORS and provides progress feedback
        // The user reported GM_download failing silently.
        // This downloads to memory first (providing progress bars) then saves to disk.
        downloadWithBlob(fileData, filename);
    }

    // Fallback: Download via Blob (Bypasses CORS usually)
    function downloadWithBlob(fileData, filename) {
        if (typeof GM_xmlhttpRequest === 'undefined') {
            downloadDirect(fileData, filename);
            return;
        }

        const url = fileData.url;
        const headers = CONFIG.USE_STEALTH_MODE ? getRealisticHeaders(url) : {};

        // MEMORY SAFEGUARD: Block Blobs > Configured Limit
        const maxBytes = (CONFIG.MAX_BLOB_SIZE_MB || 500) * 1024 * 1024;
        if (fileData.size && fileData.size > maxBytes) {
            console.error(`BLOCKED Large Blob Download: ${filename} is ${(fileData.size / 1024 / 1024).toFixed(1)}MB (Limit: ${CONFIG.MAX_BLOB_SIZE_MB}MB).`);
            alert(`⚠️ MEMORY SAFEGUARD\n\nThis file (${(fileData.size / 1024 / 1024).toFixed(1)}MB) exceeds your configured Blob limit of ${CONFIG.MAX_BLOB_SIZE_MB}MB.\n\nOpening direct link instead...`);
            downloadDirect(fileData, filename);
            return;
        }

        console.log(`Forensic Extraction started for ${filename} with stealth headers.`);
        setStatus(`Initialising extraction: ${filename}...`, 'info');

        GM_xmlhttpRequest({
            method: 'GET',
            url: url,
            headers: headers,
            responseType: 'blob',
            timeout: 120000, // 2 minute timeout for large files
            onprogress: function (progress) {
                if (progress.lengthComputable) {
                    const percent = Math.round((progress.loaded / progress.total) * 100);
                    setStatus(`Acquiring: ${percent}% of ${filename}`, 'info');

                    // Update global progress bar too if possible
                    updateProgress(progress.loaded, progress.total, `Acquiring: ${percent}%`, filename);
                } else {
                    const loadedMb = (progress.loaded / 1024 / 1024).toFixed(1);
                    setStatus(`Downloading: ${loadedMb} MB received...`, 'info');
                }
            },
            onload: function (response) {
                if (response.status === 200 || response.status === 206) {
                    const blob = response.response;
                    const blobUrl = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = blobUrl;
                    a.download = filename;
                    document.body.appendChild(a);
                    a.click();
                    document.body.removeChild(a);
                    setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);

                    console.log('Forensic extraction success:', filename);
                    setStatus(`Evidence Secured: ${filename}`, 'success');
                    StateManager.markDownloaded(url);
                    updateStats();
                    renderFileList();
                } else if (response.status === 404 || response.status === 403 || response.status === 401) {
                    // STRICT ERROR HANDLING - DO NOT FALLBACK
                    console.error(`Download ABORTED due to fatal error (${response.status}):`, filename);
                    setStatus(`Download Failed (${response.status}) - Aborted.`, 'error');

                    // If it was 403/401, the user might need to solve a CAPTCHA.
                    if (response.status === 403 || response.status === 401) {
                        alert(`Download blocked (Status ${response.status}). You may need to refresh the page and solve a CAPTCHA.`);
                    }
                } else {
                    console.warn(`Blob download failed (Status ${response.status}):`, filename);
                    setStatus(`Download failed (${response.status})`, 'error');
                    // Only fallback for non-fatal errors (e.g. 500s or weird CORS issues that aren't explicit 404s)
                    downloadDirect(fileData, filename);
                }
            },
            ontimeout: function () {
                console.error('Blob download timed out:', filename);
                setStatus('Download timed out!', 'error');
                downloadDirect(fileData, filename);
            },
            onerror: function (err) {
                console.error('Blob download error:', err);
                setStatus('Download error!', 'error');
                downloadDirect(fileData, filename);
            }
        });
    }

    // Last Resort: Direct Link Click
    function downloadDirect(fileData, filename) {
        console.log('Attempting direct download link...');
        const a = document.createElement('a');
        a.href = fileData.url;
        a.download = filename;
        a.target = '_blank'; // Open in new tab if it can't download
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);

        // We assume success here as we can't track it
        StateManager.markDownloaded(fileData.url);
        updateStats();
        renderFileList();
    }

    // Download all found files
    // Download all PENDING files
    function downloadAllFiles() {
        const pending = StateManager.getPending();

        if (pending.length === 0) {
            alert('No new files to download!');
            return;
        }

        // Filter out large files
        const tooLarge = pending.filter(f => f.isTooLarge);
        const safePending = pending.filter(f => !f.isTooLarge);

        if (safePending.length === 0 && tooLarge.length > 0) {
            alert(`⚠️ ALL PENDING FILES ARE TOO LARGE\n\n${tooLarge.length} files exceed the 500MB safety limit.\nPlease download them manually using the direct links (highlighted in amber).`);
            return;
        }

        // SAFETY LIMIT: Cap "Extract All" to prevent browser crash (Configurable)
        const MAX_SAFE_LIMIT = CONFIG.SAFETY_BATCH_LIMIT || 100;
        let filesToDownload = safePending;

        let skipMsg = '';
        if (tooLarge.length > 0) {
            skipMsg = `\n\n(${tooLarge.length} unstable large files will be skipped for safety)`;
        }

        if (safePending.length > MAX_SAFE_LIMIT) {
            if (!confirm(`⚠️ BROWSER SAFETY WARNING\n\nYou are attempting to download ${safePending.length} files at once.\nYour configured safety limit is ${MAX_SAFE_LIMIT}.\n\nClick OK to download the first ${MAX_SAFE_LIMIT} files.\n(To download more, increase the limit in Settings or use Batch mode)`)) {
                return;
            }
            filesToDownload = safePending.slice(0, MAX_SAFE_LIMIT);
        } else {
            if (!confirm(`Download ${safePending.length} files?${skipMsg}`)) return;
        }

        filesToDownload.forEach((fileData, index) => {
            console.log(`Queueing download ${index + 1}/${filesToDownload.length}: ${fileData.url}`);
            setTimeout(() => {
                downloadFile(fileData);
            }, index * 1000); // 1 second delay between downloads
        });
    }

    // Download batch of files (Limit count)
    function downloadBatch(limit) {
        const pending = StateManager.getPending();

        if (pending.length === 0) {
            alert('No new files to download!');
            return;
        }

        // Filter out large files
        const safePending = pending.filter(f => !f.isTooLarge);
        const tooLarge = pending.filter(f => f.isTooLarge);

        if (safePending.length === 0 && tooLarge.length > 0) {
            alert(`⚠️ BATCH SKIPPED\n\nAll pending files in this selection are too large for automated batch downloading.\nPlease handle them manually.`);
            return;
        }

        const toDownload = safePending.slice(0, limit);
        const skippedCount = pending.slice(0, limit).filter(f => f.isTooLarge).length;

        if (skippedCount > 0) {
            console.warn(`Batch download: Skipping ${skippedCount} large files in this range.`);
        }

        toDownload.forEach((fileData, index) => {
            console.log(`Queueing batch download ${index + 1}/${toDownload.length}: ${fileData.url}`);
            setTimeout(() => {
                downloadFile(fileData);
            }, index * 1000); // 1 second delay between downloads
        });
    }

    // Update statistics display
    function updateStats() {
        const statsElement = document.getElementById('doj-stats');
        if (statsElement) statsElement.style.display = 'grid';

        // SINGLE SOURCE OF TRUTH: StateManager
        const stats = StateManager.getStats();

        // 1. Update Tabs Badges
        const elTabFound = document.getElementById('tab-count-found');
        if (elTabFound) elTabFound.textContent = stats.found;

        const elTabDownloaded = document.getElementById('tab-count-downloaded');
        if (elTabDownloaded) elTabDownloaded.textContent = stats.downloaded;

        const elTabDetected = document.getElementById('tab-count-detected');
        if (elTabDetected) elTabDetected.textContent = stats.detected;

        const elTabFailed = document.getElementById('tab-count-failed');
        if (elTabFailed) elTabFailed.textContent = stats.failed;

        // 2. Update Header Stats
        const elDetected = document.getElementById('stat-detected');
        if (elDetected) elDetected.textContent = stats.detected;

        const elFound = document.getElementById('stat-found');
        if (elFound) elFound.textContent = stats.found;

        const elDownloaded = document.getElementById('stat-downloaded');
        if (elDownloaded) elDownloaded.textContent = stats.downloaded;

        const elFailed = document.getElementById('stat-failed');
        if (elFailed) elFailed.textContent = stats.failed;

        // 3. Update Pending Download Group
        if (StateManager.getFiles().length > 0) {
            const group = document.getElementById('doj-download-group');
            const countSpan = document.getElementById('doj-pending-count');
            if (group) group.style.display = 'flex';
            if (countSpan) countSpan.textContent = stats.found; // "Secure Evidence" checks Found items
        }

        // Update batch size label
        const batchLabel = document.getElementById('doj-batch-size-label');
        if (batchLabel) batchLabel.textContent = CONFIG.BATCH_SIZE;

        // 4. Update Category Breakdowns (Only for resolved items)
        const allFiles = StateManager.getFiles();
        const categoryCounts = { video: 0, audio: 0, image: 0, archive: 0, document: 0, forensic: 0 };
        const categoryBreakdowns = { video: {}, audio: {}, image: {}, archive: {}, document: {}, forensic: {} };

        allFiles.forEach(f => {
            if (f.status === 'found' || f.status === 'downloaded') {
                if (categoryCounts[f.category] !== undefined) {
                    categoryCounts[f.category]++;
                    const ext = f.extension || (f.url.split('?')[0].split('.').pop().toLowerCase());
                    categoryBreakdowns[f.category][ext] = (categoryBreakdowns[f.category][ext] || 0) + 1;
                } else {
                    // Safety for unknown categories
                    console.warn(`Unknown category encountered: ${f.category} for ${f.url}`);
                    // Optionally count as 'document' or just ignore to prevent crash
                }
            }
        });

        const catContainer = document.getElementById('doj-category-counts');
        if (catContainer) {
            const hasAny = Object.values(categoryCounts).some(c => c > 0);
            catContainer.style.display = hasAny ? 'flex' : 'none';
        }

        Object.keys(categoryCounts).forEach(cat => {
            const el = document.getElementById(`cat-count-${cat}`);
            if (el) {
                el.textContent = categoryCounts[cat];

                // Add breakdown tooltip for top 3 types
                const badge = el.parentElement;
                const breakdown = categoryBreakdowns[cat];
                const sorted = Object.entries(breakdown)
                    .sort((a, b) => b[1] - a[1]) // Sort by count desc
                    .slice(0, 3);

                if (sorted.length > 0) {
                    const breakdownStr = sorted.map(([ext, count]) => `.${ext}: ${count}`).join(', ');
                    badge.setAttribute('data-title', `Top Types: ${breakdownStr}`);
                    badge.style.cursor = 'help';
                } else {
                    badge.removeAttribute('data-title');
                    badge.style.cursor = 'default';
                }
            }
        });
    }

    // Fetch with retry logic (Stealth/Robustness)
    async function fetchWithRetry(url, retries = 3, delay = 1000) {
        try {
            const headers = CONFIG.USE_STEALTH_MODE ? getRealisticHeaders(url) : {};

            // Use GET with Range header instead of HEAD (more realistic)
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 10000); // Increased to 10s

            const fetchOptions = {
                method: 'GET',
                signal: controller.signal,
                headers: {
                    ...headers,
                    'Range': 'bytes=0-1024' // Request first 1KB to get headers/type without full download
                },
                credentials: 'include', // Include cookies
                redirect: 'follow'
            };

            const response = await fetch(url, fetchOptions);
            clearTimeout(timeoutId);

            // Fail fast on certain status codes (Do not retry)
            // Added 401 (Unauthorized) to fail fast list
            if (response.status === 403 || response.status === 429 || response.status === 404 || response.status === 401) {
                return response;
            }

            // If success, return response (206 Partial Content is also success for Range requests)
            if (response.ok || response.status === 206) {
                return response;
            }

            // Check if 5xx error or other retryable status
            if (response.status >= 500 && retries > 0) {
                console.warn(`Retrying ${url} (Status: ${response.status}). Retries left: ${retries}`);
                // Add exponential backoff with jitter
                const backoffDelay = delay * (1.5 + Math.random());
                await new Promise(resolve => setTimeout(resolve, backoffDelay));
                return fetchWithRetry(url, retries - 1, backoffDelay);
            }

            return response;
        } catch (error) {
            // Network error (e.g., DNS, offline, timeout)
            if (retries > 0 && error.name !== 'AbortError') { // Don't retry timeouts immediately
                console.warn(`Retrying ${url} (${error.message}). Retries left: ${retries}`);
                const backoffDelay = delay * (1.5 + Math.random());
                await new Promise(resolve => setTimeout(resolve, backoffDelay));
                return fetchWithRetry(url, retries - 1, backoffDelay);
            }
            throw error; // Propagate if no retries left
        }
    }

    // Verify a specific URL via HEAD/Ranges
    async function verifyFileUrl(url) {
        try {
            const response = await fetchWithRetry(url);

            if (response.status === 403 || response.status === 429 || response.status === 401) {
                return { success: false, reason: 'blocked', status: response.status };
            }

            if (response.ok || response.status === 206) {
                // For 206 responses, Content-Length is the RANGE size, not the file size.
                // Content-Range header format: "bytes 0-1024/TOTAL_SIZE"
                let contentLength = 0;
                const contentRange = response.headers.get('Content-Range');
                if (contentRange) {
                    const totalMatch = contentRange.match(/\/(\d+)/);
                    if (totalMatch) contentLength = parseInt(totalMatch[1]);
                }
                if (!contentLength) {
                    contentLength = parseInt(response.headers.get('Content-Length') || '0');
                }
                const contentType = response.headers.get('Content-Type') || '';

                return {
                    success: true,
                    size: contentLength,
                    type: contentType
                };
            }
        } catch (error) {
            console.debug(`Failed to verify ${url}:`, error.message);
        }
        return { success: false, reason: 'network_error' };
    }

    // Attempt to silently solve Age Verification via POST
    async function solveAgeVerification(redirectUrl) {
        return new Promise(resolve => {
            const verifyUrl = 'https://www.justice.gov/age-verify';
            console.log('Attempting silent age verification...');

            GM_xmlhttpRequest({
                method: 'GET',
                url: verifyUrl,
                onload: function (response) {
                    const parser = new DOMParser();
                    const doc = parser.parseFromString(response.responseText, 'text/html');
                    const formId = doc.querySelector('input[name="form_build_id"]')?.value;
                    const formToken = doc.querySelector('input[name="form_token"]')?.value;
                    const formIdInput = doc.querySelector('input[name="form_id"]')?.value;

                    if (!formId || !formToken) {
                        console.error('Could not find Age Verify form tokens.');
                        resolve(false);
                        return;
                    }

                    const data = new FormData();
                    data.append('age_verification', '1'); // The checkbox
                    data.append('op', 'Continue');
                    data.append('form_build_id', formId);
                    data.append('form_token', formToken);
                    data.append('form_id', formIdInput || 'age_verify_form');

                    GM_xmlhttpRequest({
                        method: 'POST',
                        url: verifyUrl,
                        data: data,
                        headers: {
                            'Content-Type': 'application/x-www-form-urlencoded' // FormData might set multipart, usually form needs urlencoded
                        },
                        // We need to convert FormData to urlencoded string manually for GM_xmlhttpRequest sometimes?
                        // Let's try raw string first as GM handles data usually.
                        // Actually, standard FormData is multipart. Drupal expects urlencoded usually.
                    });

                    // Manual URL encoding for safety
                    const params = new URLSearchParams();
                    params.append('age_verification', '1');
                    params.append('op', 'Continue');
                    params.append('form_build_id', formId);
                    params.append('form_token', formToken);
                    params.append('form_id', formIdInput || 'age_verify_form');

                    GM_xmlhttpRequest({
                        method: 'POST',
                        url: verifyUrl,
                        data: params.toString(),
                        headers: {
                            'Content-Type': 'application/x-www-form-urlencoded'
                        },
                        onload: function (postResponse) {
                            if (postResponse.status === 200 || postResponse.status === 302) {
                                console.log('Age verification POST success.');
                                resolve(true);
                            } else {
                                console.warn('Age verification POST failed status:', postResponse.status);
                                resolve(false);
                            }
                        },
                        onerror: function (err) {
                            console.error('Age verification network error:', err);
                            resolve(false);
                        }
                    });
                },
                onerror: function (err) {
                    console.error('Failed to fetch Age Verify page:', err);
                    resolve(false);
                }
            });
        });
    }

    // Test if a URL is a valid file
    async function testFileUrl(pdfUrl, extension) {
        // Robust URL replacement using URL API
        let fileUrl;
        try {
            const urlObj = new URL(pdfUrl);
            const path = urlObj.pathname;
            if (path.toLowerCase().endsWith('.pdf')) {
                // Swap extension in the pathname only
                urlObj.pathname = path.substring(0, path.length - 4) + extension;
                fileUrl = urlObj.toString();
            } else {
                // Fallback for weird patterns
                fileUrl = pdfUrl.replace(/\.pdf($|\?|#)/i, extension + '$1');
            }
        } catch (e) {
            fileUrl = pdfUrl.replace(/\.pdf$/i, extension);
        }

        // Safety check: ensure we actually changed the URL away from a PDF
        if (fileUrl.toLowerCase() === pdfUrl.toLowerCase() || /\.pdf($|\?|#)/i.test(fileUrl)) {
            console.debug(`Skipping test: replacement failed or still points to PDF for ${pdfUrl}`);
            return { success: false };
        }

        try {
            // Use retry logic instead of direct fetch
            const response = await fetchWithRetry(fileUrl);

            // Rate Limit / Block Detection
            if (response.status === 403 || response.status === 429 || response.status === 401) {
                return { success: false, reason: 'blocked', status: response.status };
            }

            if (response.status === 404) {
                return { success: false, reason: 'not_found' };
            }

            // Accept both 200 OK and 206 Partial Content
            if (response.ok || response.status === 206) {
                // For 206 responses, Content-Length is the RANGE size, not the file size.
                // Content-Range header format: "bytes 0-1024/TOTAL_SIZE"
                let contentLength = 0;
                const contentRange = response.headers.get('Content-Range');
                if (contentRange) {
                    const totalMatch = contentRange.match(/\/(\d+)/);
                    if (totalMatch) contentLength = parseInt(totalMatch[1]);
                }
                if (!contentLength) {
                    contentLength = parseInt(response.headers.get('Content-Length') || '0');
                }
                const contentType = (response.headers.get('Content-Type') || '').toLowerCase();
                const category = getFileCategory(extension);

                // FALSE POSITIVE CHECK:
                // If we get an HTML page for a non-document request, it's likely a CAPTCHA or error page
                if (contentType.includes('text/html') && category !== 'document') {
                    console.warn(`False Positive Detected: Got HTML for ${extension} request. Likely CAPTCHA/Error page.`);
                    return { success: false, reason: 'false_positive_html' };
                }

                // Check against safety limit (DEFAULT 500MB)
                const isTooLarge = contentLength > (CONFIG.MAX_FILE_SIZE || 500 * 1024 * 1024);
                if (isTooLarge) {
                    console.warn(`Large file detected: ${fileUrl} (${(contentLength / 1024 / 1024).toFixed(2)} MB). Marking as unstable.`);
                }

                // Lowered thresholds: DOJ evidence files can be very short clips or small log files
                const minSize = 100; // Virtually zero, just ensuring it's not empty

                // Enhanced Content-Type Validation
                // Only accept if content-type matches expected category OR is a binary stream
                const isValidType =
                    (contentType.includes('video') && category === 'video') ||
                    (contentType.includes('image') && category === 'image') ||
                    (contentType.includes('audio') && category === 'audio') ||
                    (contentType.includes('zip') || contentType.includes('compressed') || contentType.includes('archive') || contentType.includes('octet-stream')) ||
                    (contentType.includes('application') && !contentType.includes('pdf') && !contentType.includes('html')); // Exclude PDF/HTML applications

                if ((contentLength > minSize && isValidType) || (contentLength > minSize && contentType === 'application/octet-stream')) {

                    // ---------------------------------------------------------
                    // STRICT SIGNATURE VERIFICATION (User Request)
                    // ---------------------------------------------------------
                    let finalExtension = extension;
                    try {
                        // Clone the response to read body without consuming the original (if needed elsewhere)
                        // Actually, we can just read it since we don't return the stream
                        const buffer = await response.arrayBuffer();
                        const bytes = new Uint8Array(buffer);

                        // Check against known signatures
                        const sig = detectFileTypeFromMagicBytes(bytes);

                        if (sig) {
                            console.log(`[Signature Verify] ${extension} -> Confirmed as ${sig.ext} (${sig.cat})`);

                            // If extension mismatch, correct it!
                            if (sig.ext !== extension) {
                                // SOFT 404 DETECTION:
                                // If we asked for .avi (or any non-pdf) and got a .pdf back, it's likely the server
                                // serving the original PDF file instead of a 404.
                                if (sig.ext === '.pdf' && extension !== '.pdf') {
                                    console.warn(`[Signature Verify] SOFT 404 DETECTED: Requested ${extension}, got PDF (likely original file). Rejecting.`);
                                    return { success: false, reason: 'soft_404_pdf' };
                                }

                                console.warn(`Type Mismatch: URL has ${extension}, Magic Bytes say ${sig.ext}. Updating...`);
                                finalExtension = sig.ext;
                            }
                        } else {
                            // No signature found. 
                            // If it's a known binary type (like AVI) but has no signature, it's suspicious.
                            // But could be an obscure variant or a text file (logs, xml, etc).
                            if (['.avi', '.mp4', '.mkv', '.zip', '.pdf', '.jpg', '.png'].includes(extension)) {
                                console.warn(`[Signature Verify] WARNING: No known signature found for ${extension} file. Possible corruption or false positive.`);
                            } else {
                                console.log(`[Signature Verify] No signature match for ${extension} (might be text/unknown). Accepting based on Content-Type.`);
                            }
                        }
                    } catch (err) {
                        console.error('Error reading magic bytes during verification:', err);
                    }

                    return {
                        success: true,
                        url: fileUrl,
                        size: contentLength,
                        type: contentType || 'application/octet-stream',
                        extension: finalExtension,
                        category: getFileCategory(finalExtension),
                        timestamp: Date.now()
                    };
                } else {
                    console.warn(`Rejected candidate: ${fileUrl} | Size: ${contentLength} | Type: ${contentType} | ValidType: ${isValidType}`);
                }
            } else if ((response.url && response.url.includes('age-verify')) || response.redirected) {
                // REDIRECT DETECTED: Age Verification
                console.warn(`Redirect Detected (Age Gate?): ${response.url}`);
                setStatus('Bypassing Age Verification...', 'warning');

                const solved = await solveAgeVerification(response.url);
                if (solved) {
                    console.log('Age verification bypassed. Retrying check...');
                    return testFileUrl(pdfUrl, extension);
                } else {
                    console.error('Age verification bypass failed.');
                    return { success: false, reason: 'age_gate_failed' };
                }
            }
        } catch (error) {
            // Silently fail for requests
            console.debug(`Failed to check ${fileUrl}:`, error.message);
        }

        return { success: false };
    }

    // Update progress
    function updateProgress(current, total, status, details) {
        const progressContainer = document.getElementById('doj-progress-container');
        const progressBar = document.getElementById('doj-progress-bar');
        const progressText = document.getElementById('doj-progress-text');

        if (progressContainer) {
            progressContainer.style.display = 'block';
            const percent = (current / total) * 100;
            progressBar.style.width = `${percent}%`;

            let statusHtml = status;
            if (details) {
                statusHtml += ` <span style="opacity: 0.7; font-size: 0.9em;">(${details})</span>`;
            }
            progressText.innerHTML = statusHtml;
        }
    }

    // Inject inline result under a link
    function injectInlineResult(linkElement, fileData) {
        // Check if already injected (Robust check via attribute)
        if (linkElement.getAttribute('data-doj-injected') === 'result') {
            return;
        }

        // Mark as result immediately
        linkElement.setAttribute('data-doj-injected', 'result');

        // Cleanup existing search button if present (simple check)
        let next = linkElement.nextElementSibling;
        while (next && (next.tagName === 'BR' || (next.classList && next.classList.contains('doj-inline-search-btn')))) {
            if (next.classList && next.classList.contains('doj-inline-search-btn')) {
                next.style.display = 'none'; // Hide it
            }
            next = next.nextElementSibling;
        }

        const container = document.createElement('div');
        container.className = 'doj-inline-result';
        container.setAttribute('data-userscript', 'true');

        // Prevent events from bubbling to DOJ site handlers
        const eventTypes = ['click', 'mousedown', 'mouseup', 'mouseover', 'mouseout', 'focus', 'blur', 'keydown', 'keyup'];
        eventTypes.forEach(eventType => {
            // Bubble phase - stops events AFTER they leave children
            container.addEventListener(eventType, (e) => {
                e.stopPropagation();
            }, { capture: false });
        });

        const filename = fileData.url.split('/').pop();
        const canPlay = ['video', 'audio', 'image'].includes(fileData.category);

        container.innerHTML = `
                    <div class="doj-inline-icon">${getCategoryIcon(fileData.category)}</div>
                    <div class="doj-inline-info">
                        <div class="doj-inline-name">${filename}</div>
                        <div class="doj-inline-meta">${(fileData.size / 1024 / 1024).toFixed(1)} MB • ${fileData.category}</div>
                    </div>
                    <div class="doj-inline-actions">
                        <button class="doj-file-dl rescan-btn" style="background: rgba(59, 130, 246, 0.3); padding: 6px 12px;" title="Deep Scan">
                            🔄 Rescan
                        </button>
                        <button class="doj-file-dl download-btn" style="background: rgba(255,255,255,0.1); padding: 6px 12px;">
                            ⬇️ Download
                        </button>
                    </div>
                    `;

        // Events
        container.querySelector('.rescan-btn').onclick = (e) => {
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
            scanSingleFile(fileData, true); // Deep Scan
        };

        container.querySelector('.download-btn').onclick = (e) => {
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
            downloadFile(fileData);
        };

        // Insert after the link
        // We put a line break before it to ensure it sits below
        const br = document.createElement('br');
        if (linkElement.parentNode) {
            linkElement.parentNode.insertBefore(br, linkElement.nextSibling);
            linkElement.parentNode.insertBefore(container, br.nextSibling);
        }
    }

    // Add file to results list (Wrapper for StateManager)
    function addFileToResults(fileData) {
        if (StateManager.addFile(fileData)) {
            // Only re-render if new file added
            renderFileList();
            // updateStats(); // Handled by renderFileList now
        }
    }




    // State Management Class
    // Helper to get filename stem (no extension)
    function getFilenameStem(url) {
        try {
            const filename = url.split('/').pop();
            return filename.substring(0, filename.lastIndexOf('.')) || filename;
        } catch (e) {
            return '';
        }
    }

    // Generate the correct download filename using detected file type (magic-number based).
    // If AUTO_RENAME_DOWNLOADS is enabled and the detected extension differs from the URL
    // extension, the file is renamed so the OS/apps recognise it correctly.
    function generateDownloadFilename(fileData) {
        try {
            const originalUrl = fileData.originalUrl || fileData.url;
            const stem = getFilenameStem(originalUrl);
            const urlFilename = originalUrl.split('/').pop();
            const urlExt = urlFilename.substring(stem.length + 1).toLowerCase();

            // Detected extension stored by snipeFileType / updateFound (strip leading dot)
            const detectedExt = fileData.extension
                ? fileData.extension.replace(/^\./, '').toLowerCase()
                : null;

            if (CONFIG.AUTO_RENAME_DOWNLOADS && detectedExt && detectedExt !== urlExt) {
                const newFilename = `${stem}.${detectedExt}`;
                console.log(`[Auto-Rename] "${urlFilename}" → "${newFilename}" (magic-bytes detected: ${fileData.type || detectedExt})`);
                return newFilename;
            }

            // No rename needed – use the already-resolved URL filename
            return fileData.url.split('/').pop();
        } catch (e) {
            return fileData.url.split('/').pop();
        }
    }

    // State Management Object
    const StateManager = {
        STORAGE_KEY: 'dojFileDetectorState',
        state: {
            files: [],
            downloadStats: { found: 0, downloaded: 0, failed: 0 }
        },

        init() {
            const storedState = localStorage.getItem(this.STORAGE_KEY);
            if (storedState) {
                try {
                    const parsedState = JSON.parse(storedState);
                    this.state.files = parsedState.files || [];
                    this.state.downloadStats = parsedState.downloadStats || { found: 0, downloaded: 0, failed: 0 };
                } catch (e) {
                    console.error('State load error', e);
                }
            }
            // Ensure downloadStats is always initialized
            this.state.downloadStats = this.state.downloadStats || { found: 0, downloaded: 0, failed: 0 };

            // downloadStats synced dynamically via getStats() — no manual override needed

            // DownloadStats synced dynamically via getStats()

            // Run cleanup on load to fix existing dupes
            this.cleanupDuplicates();

            this.saveState();
        },

        saveState() {
            try {
                // OPTIMIZATION: Remove redundant originalUrl to save space
                this.state.files.forEach(f => {
                    if (f.originalUrl && f.originalUrl === f.url) {
                        delete f.originalUrl;
                    }
                });

                const stateStr = JSON.stringify({
                    files: this.state.files,
                    downloadStats: this.state.downloadStats
                });

                localStorage.setItem(this.STORAGE_KEY, stateStr);
            } catch (e) {
                if (e.name === 'QuotaExceededError' || e.code === 22) {
                    console.error('CRITICAL: LocalStorage Full! clean up old data.');
                    alert('CRITICAL: Browser Storage is FULL!\n\nThe script cannot save new findings. Please export your data and then Clear History.');

                    // Emergency Cleanup (Sacrifice processed links or old detected items?)
                    // For now, just stop saving to prevent corruption
                } else {
                    console.error('State save error:', e);
                }
            }
        },

        // Get a specific file by URL
        getFile(url) {
            return this.state.files.find(f => f.url === url || f.originalUrl === url);
        },




        getFiles() {
            return [...this.state.files].sort((a, b) => b.timestamp - a.timestamp); // Sort by new
        },

        addFile(fileData) {
            // 1. Strict URL Check (Existing)
            if (this.state.files.some(f =>
                f.url === fileData.url ||
                (f.originalUrl && (f.originalUrl === fileData.url || f.originalUrl === fileData.originalUrl))
            )) {
                return false;
            }

            // 2. Smart Stem Check (New)
            // If we have "video1.mp4" (found), reject "video1.pdf" (detected)
            const newStem = getFilenameStem(fileData.url);
            const existingMatch = this.state.files.find(f => {
                const existingStem = getFilenameStem(f.url);
                const originalStem = f.originalUrl ? getFilenameStem(f.originalUrl) : '';
                return (existingStem === newStem || originalStem === newStem);
            });

            if (existingMatch) {
                // We found a match by name!
                // If the new one is just "detected" and we already have a "found/downloaded" one, skip it.
                if (fileData.status === 'detected' && (existingMatch.status === 'found' || existingMatch.status === 'downloaded')) {
                    // EXPLICIT LOGGING FOR USER DEBUGGING
                    console.log(`Duplicate Rejected: ${getFilenameStem(fileData.url)} is already ${existingMatch.status} as ${getFilenameStem(existingMatch.url)}`);
                    console.log(`Deduplicated: ${fileData.url} matches existing ${existingMatch.url}`);

                    // Update originalUrl if missing on the existing strict match
                    if (!existingMatch.originalUrl) {
                        existingMatch.originalUrl = fileData.url;
                        this.saveState();
                    }
                    return false;
                }
            }

            // Add timestamp if missing
            if (!fileData.timestamp) fileData.timestamp = Date.now();

            this.state.files.push(fileData);
            this.saveState();
            return true;
        },

        cleanupDuplicates() {
            const uniqueFiles = new Map();
            let cleanedCount = 0;

            // Sort by status priority (downloaded > found > detected) to keep best version
            const priority = { 'downloaded': 3, 'found': 2, 'detected': 1 };

            this.state.files.sort((a, b) => {
                const pA = priority[a.status] || 0;
                const pB = priority[b.status] || 0;
                return pB - pA; // Descending
            });

            this.state.files.forEach(file => {
                const stem = getFilenameStem(file.url);
                if (!uniqueFiles.has(stem)) {
                    uniqueFiles.set(stem, file);
                } else {
                    // Duplicate found!
                    cleanedCount++;
                    const existing = uniqueFiles.get(stem);
                    // Merge data if needed (e.g. originalUrl)
                    if (!existing.originalUrl && file.originalUrl) {
                        existing.originalUrl = file.originalUrl;
                    }
                    if (!existing.originalUrl && file.url.endsWith('.pdf')) {
                        existing.originalUrl = file.url;
                    }
                }
            });

            if (cleanedCount > 0) {
                console.log(`Cleaned up ${cleanedCount} duplicate files.`);
                this.state.files = Array.from(uniqueFiles.values());
                this.saveState();
                updateStats(); // Refresh UI
            }
        },

        markDownloaded(url) {
            const file = this.state.files.find(f => f.url === url);
            if (file && file.status !== 'downloaded') {
                file.status = 'downloaded';
                this.saveState();
                return true;
            }
            return false;
        },

        markFound(url) {
            const file = this.state.files.find(f => f.url === url);
            if (file) {
                file.status = 'found';
                this.saveState();
                return true;
            }
            return false;
        },

        markFailed(url) {
            const file = this.state.files.find(f => f.url === url);
            if (file) {
                file.status = 'failed';
                this.saveState();
                return true;
            }
            return false;
        },

        // Robust update for found files (handles URL changes)
        updateFound(oldUrl, fileData) {
            // DEBUG: Trace lookup
            // console.log(`Looking for record: ${oldUrl}`);

            const file = this.state.files.find(f => f.url === oldUrl || f.originalUrl === oldUrl);

            if (!file) {
                // Try decoded/encoded versions if direct match fails
                const decoded = decodeURIComponent(oldUrl);
                if (decoded !== oldUrl) {
                    const fileDecoded = this.state.files.find(f => f.url === decoded || f.originalUrl === decoded);
                    if (fileDecoded) return this.updateFound(decoded, fileData); // Recurse with correct key
                }
                console.warn(`State Update Failed: Could not find record for ${oldUrl}`);
                return false;
            }

            if (file) {
                file.url = fileData.url;
                file.type = fileData.type;
                file.size = fileData.size;
                file.category = fileData.category;
                file.extension = fileData.extension;
                file.status = 'found';
                if (fileData.confirmedPdf) file.confirmedPdf = true;

                // Ensure originalUrl is set
                if (!file.originalUrl) file.originalUrl = oldUrl;

                this.saveState();
                return true;
            }
            return false;
        },

        getPending() {
            // Pending for DOWNLOAD: files found but not downloaded
            return this.state.files.filter(f => f.status === 'found');
        },

        getDetected() {
            // Pending for SCAN: files detected but not scanned
            return this.state.files.filter(f => f.status === 'detected');
        },

        // Fast check: is this stem already resolved (found/downloaded)?
        isStemResolved(url) {
            const stem = getFilenameStem(url);
            return this.state.files.some(f =>
                (f.status === 'found' || f.status === 'downloaded') &&
                (getFilenameStem(f.url) === stem || (f.originalUrl && getFilenameStem(f.originalUrl) === stem))
            );
        },

        getStats() {
            const files = this.state.files;
            return {
                detected: files.filter(f => f.status === 'detected').length,
                found: files.filter(f => f.status === 'found').length,
                downloaded: files.filter(f => f.status === 'downloaded').length,
                failed: files.filter(f => f.status === 'failed').length
            };
        },



        clear() {
            this.state.files = [];
            // this.state.processedLinks.clear();
            this.saveState();

            // UI Update
            document.getElementById('doj-file-list').innerHTML = '';
            updateStats();
        },

        clearStats(statusType) {
            // Remove files with specific status
            if (this.state.files) {
                this.state.files = this.state.files.filter(f => f.status !== statusType);
                this.saveState();
            }
        },

        updateUI() {
            updateStats();
        },

        // Export State to JSON
        exportState() {
            const dataStr = JSON.stringify(this.state.files, null, 2);
            const blob = new Blob([dataStr], { type: "application/json" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `doj_detected_links_${new Date().toISOString().slice(0, 10)}.json`;
            a.click();
            URL.revokeObjectURL(url);
        },

        // Import State from JSON
        async importState(file) {
            try {
                const text = await file.text();
                const json = JSON.parse(text);

                if (!Array.isArray(json)) throw new Error("Invalid format: Root must be an array");

                let addedCount = 0;
                json.forEach(item => {
                    // Validate item structure
                    if (item.url && item.status) {
                        // Reset status if needed, or keep as is?
                        // User likely wants to import "found" or "detected" items.
                        // Let's keep them as imported, but maybe allow re-scanning.
                        if (this.addFile(item)) {
                            addedCount++;
                        }
                    }
                });

                alert(`✅ Imported ${addedCount} new links!`);
                this.updateUI();
                // Render list
                // Need to call renderFileList() but it's outside. 
                // We'll rely on updateUI or caller to refresh.
            } catch (e) {
                alert('❌ Import Failed: ' + e.message);
                console.error(e);
            }
        }
    };

    // Initialize State Manager
    StateManager.init();


    // Collect Links (Auto-Run)
    function collectPageLinks() {
        // 0. CHECK FOR AGE VERIFICATION
        const ageCheckbox = document.querySelector('input[type="checkbox"][name*="age"], input[type="checkbox"][value*="18"], input[name="age_verification"]');
        const ageSubmit = document.querySelector('input[type="submit"][value*="Continue"], button[type="submit"], input[type="submit"], .age-submit, form[action*="age-verify"] input[type="submit"]');
        if (ageCheckbox && ageSubmit) {
            console.log('🔞 Age verification detected. Auto-checking and submitting...');
            ageCheckbox.checked = true;
            ageSubmit.click();
            return; // Stop collection, page will redirect
        }

        // 1. CHECK FOR ROBOT RE-AUTH
        const robotBtn = document.querySelector('input[value="I am not a robot"]');
        if (robotBtn) {
            console.log('🤖 "I am not a robot" button detected. Auto-clicking...');
            robotBtn.click();
            return; // Stop collection, page will reload/change
        }

        // Autofill Search Input
        const searchInput = document.getElementById('searchInput');
        if (searchInput && searchInput.value === '') {
            searchInput.value = 'No Images Produced';
            searchInput.dispatchEvent(new Event('input', { bubbles: true }));
            searchInput.dispatchEvent(new Event('change', { bubbles: true }));
            console.log('Autofilled search input');

            // Auto-click search button
            setTimeout(() => {
                const searchBtn = document.getElementById('searchButton');
                if (searchBtn) {
                    console.log('Clicking search button...');
                    searchBtn.click();
                }
            }, 500); // Short delay to allow events to process
        }

        // Case-insensitive selector workaround
        const allLinks = Array.from(document.querySelectorAll('a'));
        const pdfLinks = allLinks.filter(a => a.href && /\.pdf($|\?|#)/i.test(a.href));

        console.log(`Auto-collecting: Found ${pdfLinks.length} PDF links.`);

        let newCount = 0;

        pdfLinks.forEach(link => {
            let fileData = StateManager.getFile(link.href);
            let isNew = false;

            if (!fileData) {
                // New detection
                fileData = {
                    url: link.href,
                    originalUrl: link.href,
                    status: 'detected',
                    type: 'application/pdf',
                    category: 'document',
                    size: 0,
                    timestamp: Date.now()
                };
                if (StateManager.addFile(fileData)) {
                    newCount++;
                    isNew = true;
                }
            }

            // INLINE UI LOGIC
            // 1. If found/downloaded, show result immediately
            if (fileData.status === 'found' || fileData.status === 'downloaded') {
                injectInlineResult(link, fileData);
            }
            // 2. If valid but not found, show Search Button (avoid double injection)
            else if (!link.hasAttribute('data-doj-injected')) {
                // Extra check for legacy class (just in case)
                if (link.nextElementSibling && link.nextElementSibling.classList.contains('doj-inline-search-btn')) {
                    link.setAttribute('data-doj-injected', 'button');
                } else {
                    link.setAttribute('data-doj-injected', 'button');
                    const btn = document.createElement('span');
                    btn.className = 'doj-inline-search-btn';
                    btn.innerHTML = '🔍';
                    btn.title = 'Scan this file specifically';
                    btn.style.cursor = 'pointer';
                    btn.style.marginLeft = '8px';
                    btn.style.fontSize = '14px';

                    btn.onclick = async (e) => {
                        e.preventDefault();
                        e.stopPropagation();

                        // Refresh file object from state to get latest
                        let targetFile = StateManager.getFile(link.href);
                        if (!targetFile) return;

                        // Visual feedback
                        btn.innerHTML = '⏳';
                        btn.style.cursor = 'wait';

                        try {
                            await scanSingleFile(targetFile);

                            // Check result
                            if (targetFile.status === 'found') {
                                btn.style.display = 'none'; // Hide button
                                // Result is injected by scanSingleFile -> injectInlineResult
                            } else {
                                btn.innerHTML = '❌';
                                btn.title = 'Not found (likely 404/Block)';
                                setTimeout(() => {
                                    btn.innerHTML = '🔍';
                                    btn.style.cursor = 'pointer';
                                }, 2000);
                            }
                        } catch (err) {
                            console.error(err);
                            btn.innerHTML = '⚠️';
                        }
                    };

                    if (link.parentNode) {
                        link.parentNode.insertBefore(btn, link.nextSibling);
                    }
                }
            }
        });

        if (newCount > 0) {
            console.log(`Added ${newCount} new links to collection.`);
            renderFileList(); // Update UI to show new detected items
            StateManager.updateUI();
        }

        // Auto-Crawl: Trigger next page if active
        // effectively creating a loop: Page Load -> Collect -> Trigger Next -> Page Load...
        if (localStorage.getItem('doj_auto_crawl') === 'true') {
            triggerNextPage();
        }
    }

    // Scan current page for files (File-First Sticky-Type + Concurrent Worker Pool)
    async function scanCurrentPage(forceRescan = false) {
        // Pre-populate resolvedLinks from already-found/downloaded files
        resolvedLinks.clear();
        StateManager.getFiles().forEach(f => {
            if (f.status === 'found' || f.status === 'downloaded') {
                resolvedLinks.add(getFilenameStem(f.url));
                if (f.originalUrl) resolvedLinks.add(getFilenameStem(f.originalUrl));
            }
        });

        if (forceRescan) {
            // FORCE RESCAN: Reset file states
            console.log('Force Rescan initiated: Clearing cache and resetting statuses...');
            resolvedLinks.clear();

            // Reset 'failed' items to 'detected'
            const allFiles = StateManager.getFiles();
            let resetCount = 0;
            allFiles.forEach(f => {
                if (f.status === 'failed' || f.status === 'detected') {
                    f.status = 'detected';
                    resetCount++;
                }
            });
            console.log(`Force reset ${resetCount} files for re-scan.`);
        } else {
            console.log(`Smart Scan: Skipping ${resolvedLinks.size} already-resolved stems.`);
        }
        StateManager.saveState();
        renderFileList(); // Update UI immediately
        updateStats();

        // Enforce concurrency limit
        const concurrentLimit = CONFIG.MAX_CONCURRENT || 1;

        // Helper to update status (Refactored to global)

        // Get links that are in 'detected' or 'failed' state
        let detectedFiles = StateManager.state.files.filter(f => f.status === 'detected' || f.status === 'failed');
        console.log(`Scanning ${detectedFiles.length} links (Detected + Missed, Parallel: ${concurrentLimit})...`);

        if (detectedFiles.length === 0) {
            collectPageLinks();
            detectedFiles = StateManager.getDetected();

            if (detectedFiles.length === 0) {
                const stats = StateManager.getStats();
                const totalResolved = stats.found + stats.downloaded;
                if (totalResolved > 0) {
                    setStatus(`${totalResolved} files already resolved. No new links found on this page.`, 'info');
                    console.log(`Scan skipped: ${totalResolved} files already resolved, 0 new files discovered.`);
                } else {
                    setStatus('No links discovered. Reload or find a page with PDFs.', 'error');
                }
                return;
            }
        }

        console.log(`Processing ${detectedFiles.length} detected links`);
        setStatus(`Queued ${detectedFiles.length} files for scanning...`, 'info');

        updateProgress(0, 100, `Starting scan (${concurrentLimit} threads)...`);

        // 1. Fallback extension list – used only when the magic byte probe is inconclusive.
        const fallbackCategoryOrder = Object.keys(FILE_EXTENSIONS).filter(cat => CONFIG.ENABLED_TYPES[cat]);
        let fallbackExtensions = [];
        fallbackCategoryOrder.forEach(category => {
            const categoryExts = FILE_EXTENSIONS[category].filter(ext => CONFIG.ENABLED_EXTENSIONS[ext] !== false);
            fallbackExtensions.push(...categoryExts);
        });

        // 2. Build task list
        let filesToCheck = detectedFiles.filter(f => f.status === 'detected');
        if (CONFIG.RANDOMIZE_ORDER) {
            filesToCheck = shuffleArray(filesToCheck);
        }

        const totalFiles = filesToCheck.length;
        if (totalFiles === 0) {
            setStatus('All files already resolved!', 'success');
            return;
        }

        // 3. Shared State
        let processedCount = 0;
        let globalFileIndex = 0;
        let isBlocked = false;

        // 4. Worker Function
        const scannerWorker = async (workerId) => {
            console.log(`Worker ${workerId} started`);

            while (globalFileIndex < totalFiles) {
                if (isBlocked) break;

                // Claim next file
                const myIndex = globalFileIndex++;
                if (myIndex >= totalFiles) break;

                const fileEntry = filesToCheck[myIndex];
                const pdfUrl = fileEntry.url;

                // DEDUPLICATION: Skip files whose stems are already resolved
                const stem = getFilenameStem(pdfUrl);
                if (resolvedLinks.has(stem) || StateManager.isStemResolved(pdfUrl)) {
                    console.log(`Skipping already-resolved: ${stem}`);
                    processedCount++;
                    continue;
                }

                // Track Scanning State
                scanningUrls.add(pdfUrl);

                const itemElement = document.getElementById(`file-item-${sanitizeId(pdfUrl)}`);
                if (itemElement) itemElement.classList.add('scanning');

                const msg = `Scanning... (${processedCount}/${totalFiles}) | Threads: ${concurrentLimit}`;
                if (workerId === 0) setStatus(msg, 'info');
                updateProgress(Math.round((processedCount / totalFiles) * 100), 100, msg);

                // Phase 1: Magic byte probe — 1 Range request identifies file type instantly.
                let fileData = await snipeFileType(pdfUrl);

                // Phase 2: Extension loop fallback (signature unrecognized).
                if (!fileData) {
                    for (let i = 0; i < fallbackExtensions.length; i++) {
                        if (isBlocked) break;
                        const extension = fallbackExtensions[i];
                        const candidate = await testFileUrl(pdfUrl, extension);
                        if (candidate.success) {
                            fileData = candidate;
                            break;
                        } else if (candidate.reason === 'blocked') {
                            console.error('BLOCKED Signal received!');
                            isBlocked = true;
                            setStatus('SCAN BLOCKED (403/429). Reloading in 5s...', 'warning');
                            localStorage.setItem('doj_resume_scan', 'true');
                            setTimeout(() => window.location.reload(), 5000);
                            return;
                        }
                        await randomDelay(CONFIG.DELAY_MIN, CONFIG.DELAY_MAX);
                    }
                }

                if (fileData && fileData.success) {
                    console.log(`MATCH: ${fileData.url} (Worker ${workerId})`);
                    if (StateManager.updateFound(pdfUrl, fileData)) {
                        console.log(`State updated for ${getFilenameStem(fileData.url)}: FOUND`);
                    } else {
                        console.error(`CRITICAL: Failed to update state for ${pdfUrl}.`);
                    }
                    renderFileList();
                    updateStats();
                    const linkElement = document.querySelector(`a[href="${pdfUrl}"]`);
                    if (linkElement) injectInlineResult(linkElement, fileEntry);
                    resolvedLinks.add(getFilenameStem(fileData.url));
                    resolvedLinks.add(stem);
                } else {
                    // MARK AS FAILED to prevent re-scanning
                    console.log(`Marking ${stem} as FAILED (no valid file found after ${fallbackExtensions.length} probes).`);
                    StateManager.markFailed(pdfUrl);
                    renderFileList();
                    updateStats();
                }

                // Cleanup Scanning State
                scanningUrls.delete(pdfUrl);
                const finalEl = document.getElementById(`file-item-${sanitizeId(pdfUrl)}`);
                if (finalEl) finalEl.classList.remove('scanning');

                if (!isBlocked) processedCount++;
            }
            console.log(`Worker ${workerId} finished`);
        };

        // 5. Start Workers
        const workers = [];
        for (let i = 0; i < concurrentLimit; i++) {
            workers.push(scannerWorker(i));
        }

        // Wait for all to finish
        await Promise.all(workers);

        if (!isBlocked) {
            updateProgress(100, 100, 'Scan complete!');
            setStatus('Scan Complete!', 'success');
            renderFileList(); // Final clean render
            updateStats();

        }
    }


    // Handle SPA/AJAX Navigation
    function initNavigationObserver() {
        let lastUrl = location.href;
        let timeout;

        const observer = new MutationObserver((mutations) => {
            const url = location.href;

            // 1. Check URL Change
            if (url !== lastUrl) {
                lastUrl = url;
                console.log('URL changed to:', url);
                handleNavigation();
                return;
            }

            // 2. Check Content Changes (AJAX load without URL change)
            // Filter out mutations that are just our own UI updates
            const isInternalUpdate = mutations.every(m => {
                let target = m.target;
                // Climb up to check if inside our container
                while (target && target.nodeType === 1) { // Element node
                    if (target.id === 'doj-file-detector' ||
                        target.id === 'doj-media-modal' ||
                        target.id === 'doj-settings-modal' ||
                        target.classList?.contains('doj-file-item')) {
                        return true;
                    }
                    target = target.parentNode;
                }
                return false;
            });

            if (isInternalUpdate) return;

            if (timeout) clearTimeout(timeout);
            timeout = setTimeout(() => {
                // Debounced content check
                collectPageLinks();
            }, CONFIG.PAGE_LOAD_DELAY || 1000);
        });

        observer.observe(document.body, { subtree: true, childList: true });

        // Backup: History API patching
        const pushState = history.pushState;
        history.pushState = function () {
            pushState.apply(history, arguments);
            handleNavigation();
        };

        const replaceState = history.replaceState;
        history.replaceState = function () {
            replaceState.apply(history, arguments);
            handleNavigation();
        };

        window.addEventListener('popstate', handleNavigation);
    }

    function handleNavigation() {
        console.log('Navigation detected. Preserving history.');

        // Reset local scan state, but KEEP global history
        resolvedLinks.clear();

        // Reset progress bar
        const progressContainer = document.getElementById('doj-progress-container');
        if (progressContainer) progressContainer.style.display = 'none';

        // Ensure UI is up to date
        StateManager.updateUI();
        collectPageLinks();
    }

    // Auto-Crawl Logic
    function toggleAutoCrawl() {
        const isCrawling = localStorage.getItem('doj_auto_crawl') === 'true';
        const newState = !isCrawling;
        localStorage.setItem('doj_auto_crawl', newState);
        updateAutoCrawlButton();

        if (newState) {
            triggerNextPage();
        }
    }

    function updateAutoCrawlButton() {
        const btn = document.getElementById('doj-auto-crawl');
        const isCrawling = localStorage.getItem('doj_auto_crawl') === 'true';
        if (btn) {
            btn.innerHTML = isCrawling ? '<span>🛑</span> Stop Crawl' : '<span>▶️</span> Auto-Crawl';
            btn.style.background = isCrawling ? '#ef4444' : '#8b5cf6';
            // Pulsing effect if crawling
            btn.style.animation = isCrawling ? 'pulse 2s infinite' : 'none';
        }
    }

    function triggerNextPage() {
        const isCrawling = localStorage.getItem('doj_auto_crawl') === 'true';
        if (!isCrawling) return;

        // Visual feedback
        const statusEl = document.getElementById('doj-status') || document.getElementById('doj-progress-text');
        if (statusEl) statusEl.textContent = 'Auto-Crawl: Finding next page...';

        setTimeout(() => {
            // Find inputs that might be "Next"
            // 1. Try generic "Next" text in links
            const allLinks = Array.from(document.querySelectorAll('a, button'));
            let nextBtn = allLinks.find(el => {
                const text = el.textContent.trim().toLowerCase();
                return text === 'next' || text === 'next >' || text.includes('next page');
            });

            // 2. Try class based (USA Design System) if text fails
            if (!nextBtn) {
                nextBtn = document.querySelector('.usa-pagination__next-page') ||
                    document.querySelector('.next-page') ||
                    document.querySelector('[rel="next"]');
            }

            if (nextBtn) {
                console.log('Auto-Crawl: Clicking Next >>');
                nextBtn.click();
            } else {
                console.log('Auto-Crawl: End of line. Stopping.');
                localStorage.setItem('doj_auto_crawl', 'false');
                updateAutoCrawlButton();
                alert('Auto-Crawl Complete: No "Next" button found.');
            }
        }, CONFIG.AUTO_CRAWL_DELAY || 2000); // Variable delay
    }

    // Initialize
    function init() {
        console.log(`Epstein File Sniper v${SCRIPT_VERSION}: Initializing...`);

        injectStyles();
        initConfig();

        // Inject Pulse Animation for button
        const pulseStyle = document.createElement('style');
        pulseStyle.textContent = `
                    @keyframes pulse {
                        0% { box-shadow: 0 0 0 0 rgba(239, 68, 68, 0.7); }
                        70% { box-shadow: 0 0 0 10px rgba(239, 68, 68, 0); }
                        100% { box-shadow: 0 0 0 0 rgba(239, 68, 68, 0); }
                    }
                    `;
        (document.head || document.documentElement).appendChild(pulseStyle);

        const start = () => {
            if (document.getElementById('doj-file-detector')) return; // Avoid double init

            createMainInterface();
            StateManager.updateUI(); // Load saved history
            renderFileList();
            initNavigationObserver();
            collectPageLinks(); // Check immediately

            // Auto-Crawl Init
            updateAutoCrawlButton();
            const crawlBtn = document.getElementById('doj-auto-crawl');
            if (crawlBtn) crawlBtn.onclick = toggleAutoCrawl;

            // Trigger crawl if active
            if (localStorage.getItem('doj_auto_crawl') === 'true') {
                triggerNextPage();
            }

            // Trigger Auto-Resume from Rate Limit
            if (localStorage.getItem('doj_resume_scan') === 'true') {
                console.log('DOJ Auto-Resume: Recovering from rate limit...');
                localStorage.removeItem('doj_resume_scan');
                setStatus('Resuming scan after rate limit reload...', 'info');
                setTimeout(() => {
                    scanCurrentPage(false);
                }, 2000);
            }

            console.log(`Epstein File Sniper v${SCRIPT_VERSION}: Ready!`);
        };

        if (document.readyState === 'complete' || document.readyState === 'interactive') {
            setTimeout(start, 500);
        } else {
            window.addEventListener('DOMContentLoaded', () => setTimeout(start, 500));
        }
    }

    init();

})();