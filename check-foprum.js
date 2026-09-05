import * as cheerio from 'cheerio';
import fs from 'node:fs/promises';

const CONFIG = {
    forumId: 23,
    forumUrl: 'https://stellacinis.jcink.net/index.php?showforum=23',
    baseUrl: 'https://stellacinis.jcink.net',
    stateFile: './state.json'
};

const webhookUrl = process.env.DISCORD_WEBHOOK_URL;

if (!webhookUrl) {
    throw new Error(
        'Le secret GitHub DISCORD_WEBHOOK_URL est absent.'
    );
}

/* =========================================================
   OUTILS
========================================================= */

function absoluteUrl(url) {
    return new URL(url, CONFIG.baseUrl).href;
}


function extractTopicId(url) {

    try {

        const parsed = new URL(
            url,
            CONFIG.baseUrl
        );

        const id = parsed.searchParams.get('showtopic');

        return id
            ? Number(id)
            : null;

    } catch {

        return null;

    }

}


function cleanText(text) {

    return String(text || '')
        .replace(/\s+/g, ' ')
        .trim();

}


async function fetchHtml(url) {

    console.log('GET', url);

    const response = await fetch(url, {

        redirect: 'follow',

        headers: {
            'User-Agent':
                'Mozilla/5.0 Stella-Cinis-Discord-Notifier/1.0',
            'Accept':
                'text/html,application/xhtml+xml'
        }

    });

    if (!response.ok) {

        throw new Error(
            `Erreur HTTP ${response.status} pour ${url}`
        );

    }

    return {
        html: await response.text(),
        finalUrl: response.url
    };

}


/* =========================================================
   DISCORD
========================================================= */

async function sendDiscord(embed) {

    const response = await fetch(webhookUrl, {

        method: 'POST',

        headers: {
            'Content-Type': 'application/json'
        },

        body: JSON.stringify({
            username: 'Stella Cinis',
            embeds: [embed]
        })

    });

    if (!response.ok) {

        const body = await response.text();

        throw new Error(
            `Discord ${response.status}: ${body}`
        );

    }

}


async function sendNewTopic(topic, latestPost) {

    await sendDiscord({

        title: '✨ Nouveau sujet',

        description:
            `**${topic.title}**`,

        url:
            `${CONFIG.baseUrl}/index.php?showtopic=${topic.id}`,

        fields: [

            {
                name: 'Auteur',
                value:
                    latestPost?.author ||
                    'Inconnu',
                inline: true
            },

            {
                name: 'Forum',
                value:
                    'Forum 23',
                inline: true
            }

        ],

        footer: {
            text: 'Stella Cinis'
        },

        timestamp:
            new Date().toISOString()

    });

}


async function sendNewReply(
    topic,
    post
) {

    const postUrl =
        `${CONFIG.baseUrl}/index.php?showtopic=${topic.id}` +
        `&view=findpost&p=${post.pid}`;

    await sendDiscord({

        title: '💬 Nouvelle réponse',

        description:
            `**${topic.title}**`,

        url:
            postUrl,

        fields: [

            {
                name: 'Auteur',
                value:
                    post.author ||
                    'Inconnu',
                inline: true
            },

            {
                name: 'Forum',
                value:
                    'Forum 23',
                inline: true
            }

        ],

        footer: {
            text:
                `PID ${post.pid}`
        },

        timestamp:
            new Date().toISOString()

    });

}


/* =========================================================
   LIRE LES TOPICS DU FORUM
========================================================= */

async function getForumTopics() {

    const {
        html
    } = await fetchHtml(
        CONFIG.forumUrl
    );

    const $ = cheerio.load(html);

    /*
     * Tu m'avais indiqué #innerwrapper.
     * On limite donc volontairement la recherche
     * à cet endroit.
     */

    const $wrapper =
        $('#innerwrapper').length
            ? $('#innerwrapper')
            : $('body');

    const topics = new Map();


    $wrapper
        .find('a[href*="showtopic="]')
        .each(function () {

            const $link = $(this);

            const href =
                $link.attr('href');

            if (!href) {
                return;
            }

            const topicId =
                extractTopicId(href);

            if (!topicId) {
                return;
            }


            let title =
                cleanText(
                    $link.attr('title')
                );


            if (!title) {

                title =
                    cleanText(
                        $link.text()
                    );

            }


            /*
             * Certains liens Jcink pointent vers
             * "getnewpost", "getlastpost", etc.
             * On garde quand même le topic,
             * mais on privilégie plus tard le
             * meilleur titre trouvé.
             */

            const specialLink =
                /(?:view=|p=|st=)/i.test(
                    href
                );


            if (!topics.has(topicId)) {

                topics.set(
                    topicId,
                    {
                        id: topicId,
                        title:
                            title ||
                            `Sujet ${topicId}`,
                        special:
                            specialLink
                    }
                );

                return;

            }


            const existing =
                topics.get(topicId);


            /*
             * Si le premier lien était un lien
             * "dernier message" et qu'on trouve
             * ensuite le véritable lien du titre,
             * on remplace le titre.
             */

            if (
                existing.special &&
                !specialLink &&
                title
            ) {

                existing.title =
                    title;

                existing.special =
                    false;

            }

        });


    return [
        ...topics.values()
    ];

}


/* =========================================================
   ANALYSER UN TOPIC JCINK
========================================================= */

function getPostData(
    $,
    pid
) {

    let $post =
        $(`#pid_${pid}`);


    /*
     * Jcink utilise également historiquement :
     *
     * <a name="entry123"></a>
     *
     * On garde donc un fallback.
     */

    if (!$post.length) {

        const $entry =
            $(`a[name="entry${pid}"]`);

        if ($entry.length) {

            $post =
                $entry.closest(
                    'table, .tableborder, article, div'
                );

        }

    }


    let author = 'Inconnu';


    if ($post.length) {

        const selectors = [

            '.normalname a[href*="showuser="]',

            'a[href*="showuser="] .normalname',

            'a[href*="showuser="]'

        ];


        for (
            const selector
            of selectors
        ) {

            const found =
                cleanText(
                    $post
                        .find(selector)
                        .first()
                        .text()
                );


            if (found) {

                author = found;

                break;

            }

        }

    }


    return {
        pid,
        author
    };

}


function extractPostIds($) {

    const ids =
        new Set();


    /*
     * Stella/Jcink :
     *
     * id="pid_123"
     */

    $('[id^="pid_"]').each(
        function () {

            const id =
                $(this)
                    .attr('id')
                    ?.match(
                        /^pid_(\d+)$/
                    );

            if (id) {

                ids.add(
                    Number(id[1])
                );

            }

        }
    );


    /*
     * Ancienne structure Jcink :
     *
     * name="entry123"
     */

    $('a[name^="entry"]').each(
        function () {

            const name =
                $(this)
                    .attr('name')
                    ?.match(
                        /^entry(\d+)$/
                    );

            if (name) {

                ids.add(
                    Number(name[1])
                );

            }

        }
    );


    /*
     * Autre fallback :
     *
     * &p=123
     */

    $('a[href*="p="]').each(
        function () {

            const href =
                $(this)
                    .attr('href');

            if (!href) {
                return;
            }


            try {

                const parsed =
                    new URL(
                        href,
                        CONFIG.baseUrl
                    );

                const p =
                    parsed.searchParams
                        .get('p');

                if (
                    p &&
                    /^\d+$/.test(p)
                ) {

                    ids.add(
                        Number(p)
                    );

                }

            } catch {
                // rien
            }

        }
    );


    return [
        ...ids
    ].sort(
        (a, b) =>
            a - b
    );

}


async function inspectTopic(
    topic
) {

    /*
     * getlastpost demande directement
     * la dernière page du sujet.
     */

    const url =
        `${CONFIG.baseUrl}/index.php?showtopic=${topic.id}` +
        '&view=getlastpost';


    const {
        html,
        finalUrl
    } =
        await fetchHtml(url);


    const $ =
        cheerio.load(html);


    /*
     * Vérification supplémentaire :
     * on s'assure que le topic appartient
     * réellement au forum 23.
     */

    const replyLink =
        $(
            `a[href*="act=Post"][href*="CODE=02"]`
        )
            .first()
            .attr('href');


    if (replyLink) {

        try {

            const parsed =
                new URL(
                    replyLink,
                    CONFIG.baseUrl
                );

            const forumId =
                Number(
                    parsed.searchParams
                        .get('f')
                );


            if (
                forumId &&
                forumId !== CONFIG.forumId
            ) {

                console.log(
                    `Topic ${topic.id} ignoré : forum ${forumId}`
                );

                return null;

            }

        } catch {
            // continue
        }

    }


    const postIds =
        extractPostIds($);


    if (!postIds.length) {

        console.warn(
            `Aucun PID trouvé dans le topic ${topic.id}.`
        );

        return {
            ...topic,
            postIds: [],
            lastPid: null,
            latestPost: null,
            finalUrl
        };

    }


    const lastPid =
        postIds[
            postIds.length - 1
        ];


    const posts =
        postIds.map(
            pid =>
                getPostData(
                    $,
                    pid
                )
        );


    const latestPost =
        posts.find(
            post =>
                post.pid === lastPid
        );


    return {
        ...topic,
        postIds,
        posts,
        lastPid,
        latestPost,
        finalUrl
    };

}


/* =========================================================
   STATE
========================================================= */

async function readState() {

    try {

        const raw =
            await fs.readFile(
                CONFIG.stateFile,
                'utf8'
            );

        return JSON.parse(raw);

    } catch {

        return {
            initialized: false,
            topics: {}
        };

    }

}


async function writeState(
    state
) {

    await fs.writeFile(
        CONFIG.stateFile,
        JSON.stringify(
            state,
            null,
            2
        ) + '\n',
        'utf8'
    );

}


/* =========================================================
   PROGRAMME
========================================================= */

async function main() {

    console.log(
        '=== Stella Cinis Discord ==='
    );

    console.log(
        `Forum surveillé : ${CONFIG.forumId}`
    );


    /*
     * Petit test Discord manuel.
     */

    if (
        process.env.TEST_NOTIFICATION === '1'
    ) {

        console.log(
            'Envoi de la notification de test...'
        );

        await sendDiscord({

            title:
                '✅ Stella Cinis connecté',

            description:
                'Le webhook Discord fonctionne correctement.',

            url:
                CONFIG.forumUrl,

            footer: {
                text:
                    'Surveillance du forum 23'
            },

            timestamp:
                new Date().toISOString()

        });

    }


    const state =
        await readState();


    const topics =
        await getForumTopics();


    console.log(
        `${topics.length} sujet(s) trouvé(s).`
    );


    const newState = {
        initialized: true,
        topics: {
            ...state.topics
        }
    };


    for (
        const topic
        of topics
    ) {

        try {

            const inspected =
                await inspectTopic(
                    topic
                );


            if (
                !inspected ||
                !inspected.lastPid
            ) {

                continue;

            }


            const oldTopic =
                state.topics[
                    topic.id
                ];


            /*
             * PREMIÈRE EXÉCUTION
             *
             * On enregistre tout sans envoyer
             * 50 notifications Discord.
             */

            if (
                !state.initialized
            ) {

                newState.topics[
                    topic.id
                ] = {

                    title:
                        inspected.title,

                    lastPid:
                        inspected.lastPid

                };

                continue;

            }


            /*
             * NOUVEAU TOPIC
             */

            if (!oldTopic) {

                console.log(
                    `Nouveau topic : ${topic.id}`
                );


                await sendNewTopic(
                    inspected,
                    inspected.latestPost
                );


                newState.topics[
                    topic.id
                ] = {

                    title:
                        inspected.title,

                    lastPid:
                        inspected.lastPid

                };

                continue;

            }


            /*
             * NOUVELLES RÉPONSES
             */

            const oldPid =
                Number(
                    oldTopic.lastPid || 0
                );


            const newPosts =
                inspected.posts.filter(
                    post =>
                        post.pid > oldPid
                );


            for (
                const post
                of newPosts
            ) {

                console.log(
                    `Nouvelle réponse PID ${post.pid} dans ${topic.id}`
                );


                await sendNewReply(
                    inspected,
                    post
                );

            }


            /*
             * Mise à jour du dernier PID.
             */

            newState.topics[
                topic.id
            ] = {

                title:
                    inspected.title,

                lastPid:
                    inspected.lastPid

            };


        } catch (error) {

            console.error(
                `Erreur topic ${topic.id}:`,
                error
            );

        }

    }


    await writeState(
        newState
    );


    console.log(
        'Terminé.'
    );

}


main()
    .catch(
        error => {

            console.error(error);

            process.exit(1);

        }
    );
