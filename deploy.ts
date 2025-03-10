import * as child_process from 'child_process';
import * as fs from 'fs';
import * as https from 'https';
import * as path from 'path';
import ModSourceUtils from './modSourceUtils';

// Inspired by https://gist.github.com/ktheory/df3440b01d4b9d3197180d5254d7fb65
async function fetchJson(url: string) {
    return new Promise<any>((resolve, reject) => {
        const req = https.request(url,
            (res) => {
                let body = '';
                res.on('data', (chunk) => (body += chunk.toString()));
                res.on('error', reject);
                res.on('end', () => {
                    if (res.statusCode && res.statusCode >= 200 && res.statusCode <= 299) {
                        resolve(JSON.parse(body));
                    } else {
                        reject('Request failed. status: ' + res.statusCode + ', body: ' + body);
                    }
                });
            });
        req.on('error', reject);
        req.end();
    });
}

// https://stackoverflow.com/a/53593328
function JSONstringifyOrder(obj: any, space: number) {
    const allKeys = new Set<string>();
    JSON.stringify(obj, (key, value) => {
        allKeys.add(key);
        return value;
    });
    return JSON.stringify(obj, Array.from(allKeys).sort(), space);
}

function gitExec(args: string[]) {
    const result = child_process.spawnSync('git', args, { encoding: 'utf8' });
    if (result.status !== 0) {
        throw new Error('git ' + args.join(' ') + ' failed with status ' + result.status + ' and stderr ' + result.stderr);
    }

    if (result.stderr) {
        console.warn('git ' + args.join(' ') + ' produced stderr ' + result.stderr);
    }

    return result.stdout;
}

function getModCreatedTime(modId: string) {
    const time = parseInt(gitExec([
        'log',
        '--diff-filter=A',
        '--format=%ct',
        '-1',
        '--',
        `mods/${modId}.wh.cpp`,
    ]), 10);
    if (isNaN(time)) {
        throw new Error(`Can't get created time for ${modId}`);
    }

    return time * 1000;
}

function getModModifiedTime(modId: string) {
    const time = parseInt(gitExec([
        'log',
        '--format=%ct',
        '-1',
        '--',
        `mods/${modId}.wh.cpp`,
    ]), 10);
    if (isNaN(time)) {
        throw new Error(`Can't get modified time for ${modId}`);
    }

    return time * 1000;
}

async function enrichCatalog(catalog: Record<string, any>) {
    const url = 'https://update.windhawk.net/mods_catalog_enrichment.json';
    const enrichment = await fetchJson(url);

    const app = {
        version: enrichment.app.version,
    };

    const mods: Record<string, any> = {};
    for (const [id, metadata] of Object.entries(catalog)) {
        const { id: idFromMetadata, ...rest } = metadata;
        if (id !== idFromMetadata) {
            throw new Error(`Expected ${id} === ${idFromMetadata}`);
        }

        mods[id] = {
            metadata: rest,
            details: {
                published: getModCreatedTime(id),
                updated: getModModifiedTime(id),
                defaultSorting: 0,
                rating: 0,
                users: 0,
                ...enrichment.mods[id]?.details,
            },
        };

        if (enrichment.mods[id]?.featured) {
            mods[id].featured = true;
        }
    }

    return {
        app,
        mods,
    };
}

async function generateModCatalog() {
    const modSourceUtils = new ModSourceUtils('mods');
    const catalog = modSourceUtils.getMetadataOfMods('en-US');
    return await enrichCatalog(catalog);
}

function generateModChangelog(modId: string) {
    let changelog = '';

    const modSourceUtils = new ModSourceUtils('mods');

    const commits = gitExec([
        'rev-list',
        'HEAD',
        '--',
        `mods/${modId}.wh.cpp`,
    ]).trim().split('\n');
    const lastCommit = commits[commits.length - 1];

    for (const commit of commits) {
        const modFile = gitExec([
            'show',
            `${commit}:mods/${modId}.wh.cpp`,
        ]);

        const metadata = modSourceUtils.extractMetadata(modFile, 'en-US');

        const commitTime = parseInt(gitExec([
            'log',
            '--format=%ct',
            '-1',
            commit,
        ]), 10);

        const commitFormattedDate = new Date(commitTime * 1000)
            .toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });

        const modVersionUrl = `https://github.com/ramensoftware/windhawk-mods/blob/${commit}/mods/${modId}.wh.cpp`;

        changelog += `## ${metadata.version} ([${commitFormattedDate}](${modVersionUrl}))\n\n`;

        if (commit !== lastCommit) {
            const message = gitExec([
                'log',
                '-1',
                '--pretty=format:%B',
                commit,
            ]);
            changelog += `${message}\n`;
        } else {
            changelog += 'Initial release.\n';
        }
    }

    return changelog;
}

function generateModChangelogs(modIds: string[]) {
    const changelogDir = 'changelogs';
    if (!fs.existsSync(changelogDir)) {
        fs.mkdirSync(changelogDir);
    }

    for (const modId of modIds) {
        const changelogPath = path.join(changelogDir, `${modId}.md`);
        fs.writeFileSync(changelogPath, generateModChangelog(modId));
    }
}

async function main() {
    const catalog = await generateModCatalog();
    fs.writeFileSync('catalog.json', JSONstringifyOrder(catalog, 4));

    const modIds = Object.keys(catalog.mods);
    generateModChangelogs(modIds);

    const srcPath = 'public';
    for (const file of fs.readdirSync(srcPath, { withFileTypes: true })) {
        fs.renameSync(path.join(srcPath, file.name), file.name);
    }
}

main();
