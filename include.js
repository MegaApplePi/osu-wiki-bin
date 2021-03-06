const fs = require('fs');
const { readdir, stat } = require('fs').promises;
const https = require('https');
const { safeLoad: yaml } = require('js-yaml');
const { join } = require('path');
const config = require('./config.json');

function md(text) {
    return text.replace(/[_\[\]\(\)*~\\]/g, '\\$&');
}

function modeString(modeId) {
    if (typeof modeId === 'string')
        modeId = parseInt(modeId);

    switch (modeId) {
        case 1: return 'taiko';
        case 2: return 'fruits';
        case 3: return 'mania';
        default: return 'osu';
    }
}

function osuApi(endpoint, params) {
    let url = `https://osu.ppy.sh/api/${endpoint}?k=${config.api_key}`;
    Object.keys(params).forEach(k => url += `&${k}=${params[k]}`);

    return new Promise((resolve, reject) => {
        https.get(url, res => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve(JSON.parse(data)));
        }).on('error', err => reject(err.message));
    });
}

async function userLink(userId, options) {
    options = {
        byName: false,
        flag: true,
        returnObj: false,
        ...options
    };

    const nullUser = {
        user_id: options.byName ? 0 : userId,
        username: options.byName ? userId : '<null>',
        country: '__'
    };

    const cachedUser = userLink.users[options.byName ? 'byName' : 'byId'][userId];
    const user = cachedUser !== undefined
        ? cachedUser
        : await osuApi('get_user', {
            type: options.byName ? 'string' : 'id',
            u: userId
        });

    if (user.length === 0) {
        if (options.returnObj)
            return nullUser;

        console.error(`User not found: ${userId}`);
        user.push(nullUser);
    }

    if (user[0].country === null || user[0].country === '' || user[0].country === 'XX')
        user[0].country = '__';

    userLink.users.byId[user[0].user_id] = user;
    userLink.users.byName[user[0].username] = user;

    if (options.returnObj)
        return user[0];
    else
        return (options.flag ? `![][flag_${user[0].country}] ` : '') + `[${md(user[0].username)}](https://osu.ppy.sh/users/${user[0].user_id})`;
}
userLink.users = {
    byName: {},
    byId: {}
};

async function beatmapLink(beatmapId) {
    const nullBeatmap = {
        artist: '<null>',
        beatmap_id: 0,
        beatmapset_id: 0,
        creator: '<null>',
        mode: 0,
        title: '<null>',
        version: '<null>'
    };

    const beatmap = await osuApi('get_beatmaps', {
        b: beatmapId
    });

    if (beatmap.length === 0) {
        console.error(`Beatmap not found: ${beatmapId}`);
        beatmap.push(nullBeatmap);
    }

    return `[${md(beatmap[0].artist)} - ${md(beatmap[0].title)} (${md(beatmap[0].creator)}) [${md(beatmap[0].version)}]](https://osu.ppy.sh/beatmapsets/${beatmap[0].beatmapset_id}#${modeString(beatmap[0].mode)}/${beatmap[0].beatmap_id})`;
}

async function beatmapsetLink(beatmapsetId) {
    const nullBeatmap = {
        artist: '<null>',
        beatmap_id: 0,
        beatmapset_id: 0,
        creator: '<null>',
        mode: 0,
        title: '<null>',
        version: '<null>'
    };

    const beatmap = await osuApi('get_beatmaps', {
        s: beatmapsetId
    });

    if (beatmap.length === 0) {
        console.error(`Beatmap not found: ${beatmapsetId}`);
        beatmap.push(nullBeatmap);
    }

    return `[${md(beatmap[0].artist)} - ${md(beatmap[0].title)}](https://osu.ppy.sh/beatmapsets/${beatmap[0].beatmapset_id})`;
}

async function groupMembers(groupId) {
    const userSearch = /","id":(\d+),"is_active":/g;
    const url = `https://osu.ppy.sh/groups/${groupId}?sort=username`;
    let data = await new Promise((resolve, reject) => {
        https.get(url, res => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve(data));
        }).on('error', err => reject(err.message));
    });

    data = data.substring(data.indexOf('id="json-users"'));

    const userIds = [];
    let match;

    while ((match = userSearch.exec(data)) !== null)
        userIds.push(match[1]);

    return userIds;
}

async function scrapeUser(userId) {
    const url = `https://osu.ppy.sh/users/${userId}`;
    const data = await new Promise((resolve, reject) => {
        https.get(url, res => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve(data));
        }).on('error', err => reject(err.message));
    });

    const json = data.match(/<script id="json-user" type="application\/json">\s*({.+?})\s*<\/script>/)[1];
    return JSON.parse(json);
}

function getRedirects() {
    const contents = fs.readFileSync(join(__dirname, `../wiki/redirect.yaml`), 'utf8');
    return yaml(contents);
}

const groupMap = {
    'Beatmap_Nominators': [28, 32],
    'Developers': [11],
    'Global_Moderation_Team': [4],
    'Nomination_Assessment_Team': [7],
    'osu!_Alumni': [16],
    'Support_Team': [22]
};

function loadGroup(group, locale = 'en') {
    const path = join(__dirname, `../wiki/People/The_Team/${group}/${locale}.md`);
    return fs.readFileSync(path, 'utf8');
}

async function getFiles(...paths) {
    let files = [];

    for (const path of paths) {
        if ((await stat(path)).isFile()) {
            files.push(path);
            continue;
        }

        const dirents = await readdir(path, { withFileTypes: true });

        files = files.concat(await Promise.all(dirents.map(dirent => {
            const res = join(path, dirent.name);

            if (dirent.isDirectory() && dirent.name === 'node_modules')
                return;

            return dirent.isDirectory() ? getFiles(res) : res;
        })));
    }

    return files.flat().filter(file => file !== undefined);
}

function replaceLineEndings(content, ending = '\n') {
    const originalEndingMatch = content.match(/\r\n|\r|\n/);
    const originalEnding = originalEndingMatch === null ? null : originalEndingMatch[0];

    content = content.replace(/\r\n|\r|\n/g, ending);

    return { content, originalEnding };
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(() => resolve(), ms));
}

function nestedProperty(object, property) {
    const keys = property.split('.');
    let value = object;

    for (let i = 0; i < keys.length && value !== undefined; i++)
        value = value[keys[i]];

    return value;
}

module.exports = {
    beatmapLink,
    beatmapsetLink,
    getFiles,
    getRedirects,
    groupMap,
    groupMembers,
    loadGroup,
    md,
    modeString,
    nestedProperty,
    replaceLineEndings,
    scrapeUser,
    sleep,
    userLink
};
