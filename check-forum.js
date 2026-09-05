import * as cheerio from 'cheerio';
import fs from 'node:fs/promises';

const CONFIG = {
    baseUrl: 'https://stellacinis.jcink.net',
    stateFile: './state.json',

    forums: [
        {
            id: 10,
            name: 'Fiches',
            webhook: process.env.DISCORD_WEBHOOK_FICHES
        },
        {
            id: 23,
            name: 'Idées de persos',
            webhook: process.env.DISCORD_WEBHOOK_IDEES
        },
        {
            id: 7,
            name: 'Modération',
            webhook: process.env.DISCORD_WEBHOOK_MODERATION
        },
        {
            id: 6,
            name: 'Questions & Suggestions',
            webhook: process.env.DISCORD_WEBHOOK_QUESTIONS
        }
    ],

    topics: [
        {
            id: 47,
            name: 'Bugs',
            webhook: process.env.DISCORD_WEBHOOK_BUGS
        }
    ]
};


/* =========================================================
   OUTILS
========================================================= */

function cleanText(text) {
    return String(text || '')
        .replace(/\s+/g, ' ')
        .trim();
}


function extractTopicId(url) {
    try {
        const parsed = new URL(url, CONFIG.baseUrl);
        const id = parsed.searchParams.get('showtopic');

        return id
            ? Number(id)
            : null;

    } catch {
        return null;
    }
}


function forumUrl(id) {
    return `${CONFIG.baseUrl}/index.php?showforum=${id}`;
}


function topicUrl(id) {
    return `${CONFIG.baseUrl}/index.php?showtopic=${id}`;
}


function postUrl(topicId, pid) {
    return (
        `${CONFIG.baseUrl}/index.php?showtopic=${topicId}` +
        `&view=findpost&p=${pid}`
    );
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
   VALIDATION WEBHOOKS
========================================================= */

function validateWebhooks() {
    const missing = [];

    for (const forum of CONFIG.forums) {
        if (!forum.webhook) {
            missing.push(
                `DISCORD_WEBHOOK_${forum.name}`
            );
        }
    }

    for (const topic of CONFIG.topics) {
        if (!topic.webhook) {
            missing.push(
                `Webhook pour ${topic.name}`
            );
        }
    }

    if (missing.length) {
        throw new Error(
            'Un ou plusieurs webhooks sont absents : ' +
            missing.join(', ')
        );
    }
}


/* =========================================================
   DISCORD
========================================================= */

async function sendDiscord(webhookUrl, embed) {
    if (!webhookUrl) {
        throw new Error(
            'Webhook Discord manquant.'
        );
    }

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
        const body =
            await response.text();

        throw new Error(
            `Discord ${response.status}: ${body}`
        );
    }
}


async function sendTestNotification(target) {
    await sendDiscord(
        target.webhook,
        {
            title: '✅ Stella Cinis connecté',

            description:
                `Le webhook **${target.name}** fonctionne correctement.`,

            url:
                target.type === 'forum'
                    ? forumUrl(target.id)
                    : topicUrl(target.id),

            footer: {
                text:
                    `Surveillance : ${target.name}`
            },

            timestamp:
                new Date().toISOString()
        }
    );
}


async function sendNewTopic(
    forum,
    topic,
    latestPost
) {
    await sendDiscord(
        forum.webhook,
        {
            title: '✨ Nouveau sujet',

            description:
                `**${topic.title}**`,

            url:
                topicUrl(topic.id),

            fields: [
                {
                    name: 'Auteur',
                    value:
                        latestPost?.author ||
                        'Inconnu',
                    inline: true
                },
                {
                    name: 'Section',
                    value:
                        forum.name,
                    inline: true
                }
            ],

            footer: {
                text: 'Stella Cinis'
            },

            timestamp:
                new Date().toISOString()
        }
    );
}


async function sendNewReply(
    destination,
    topic,
    post
) {
    await sendDiscord(
        destination.webhook,
        {
            title: '💬 Nouvelle réponse',

            description:
                `**${topic.title}**`,

            url:
                postUrl(
                    topic.id,
                    post.pid
                ),

            fields: [
                {
                    name: 'Auteur',
                    value:
                        post.author ||
                        'Inconnu',
                    inline: true
                },
                {
                    name: 'Section',
                    value:
                        destination.name,
                    inline: true
                }
            ],

            footer: {
                text:
                    `PID ${post.pid}`
            },

            timestamp:
                new Date().toISOString()
        }
    );
}


/* =========================================================
   LIRE LES TOPICS D'UN FORUM
========================================================= */

async function getForumTopics(forum) {
    const {
        html
    } = await fetchHtml(
        forumUrl(forum.id)
    );

    const $ =
        cheerio.load(html);

    const $wrapper =
        $('#innerwrapper').length
            ? $('#innerwrapper')
            : $('body');

    const topics =
        new Map();

    $wrapper
        .find('a[href*="showtopic="]')
        .each(function () {
            const $link =
                $(this);

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
   ANALYSER UN POST
========================================================= */

function getPostData(
    $,
    pid
) {
    let $post =
        $(`#pid_${pid}`);

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

    let author =
        'Inconnu';

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
                author =
                    found;

                break;
            }
        }
    }

    return {
        pid,
        author
    };
}


/* =========================================================
   EXTRAIRE LES PID
========================================================= */

function extractPostIds($) {
    const ids =
        new Set();

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


/* =========================================================
   ANALYSER UN TOPIC
========================================================= */

async function inspectTopic(topic) {
    const url =
        `${topicUrl(topic.id)}` +
        '&view=getlastpost';

    const {
        html,
        finalUrl
    } =
        await fetchHtml(url);

    const $ =
        cheerio.load(html);

    const postIds =
        extractPostIds($);

    if (!postIds.length) {
        console.warn(
            `Aucun PID trouvé dans le topic ${topic.id}.`
        );

        return {
            ...topic,
            postIds: [],
            posts: [],
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

        const parsed =
            JSON.parse(raw);

        return {
            initialized:
                Boolean(
                    parsed.initialized
                ),

            forums:
                parsed.forums || {},

            topics:
                parsed.topics || {}
        };

    } catch {
        return {
            initialized: false,
            forums: {},
            topics: {}
        };
    }
}


async function writeState(state) {
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
   SURVEILLER UN FORUM
========================================================= */

async function processForum(
    forum,
    state,
    newState
) {
    console.log('');
    console.log(
        `=== Forum ${forum.id} : ${forum.name} ===`
    );

    const topics =
        await getForumTopics(
            forum
        );

    console.log(
        `${topics.length} sujet(s) trouvé(s).`
    );

    if (
        !newState.forums[
            forum.id
        ]
    ) {
        newState.forums[
            forum.id
        ] = {
            topics: {}
        };
    }

    const oldForum =
        state.forums[
            forum.id
        ] || {
            topics: {}
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
                oldForum.topics[
                    topic.id
                ];

            /*
             * Première exécution :
             * on mémorise sans notifier.
             */

            if (
                !state.initialized
            ) {
                newState
                    .forums[
                        forum.id
                    ]
                    .topics[
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
             * Nouveau sujet.
             */

            if (!oldTopic) {
                console.log(
                    `Nouveau sujet ${topic.id}`
                );

                await sendNewTopic(
                    forum,
                    inspected,
                    inspected.latestPost
                );

                newState
                    .forums[
                        forum.id
                    ]
                    .topics[
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
             * Nouvelles réponses.
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
                    `Nouvelle réponse PID ${post.pid} dans topic ${topic.id}`
                );

                await sendNewReply(
                    forum,
                    inspected,
                    post
                );
            }

            /*
             * Mise à jour état.
             */

            newState
                .forums[
                    forum.id
                ]
                .topics[
                    topic.id
                ] = {
                    title:
                        inspected.title,

                    lastPid:
                        inspected.lastPid
                };

        } catch (error) {
            console.error(
                `Erreur forum ${forum.id}, topic ${topic.id}:`,
                error
            );
        }
    }
}


/* =========================================================
   SURVEILLER UN TOPIC PRÉCIS
========================================================= */

async function processSingleTopic(
    destination,
    state,
    newState
) {
    console.log('');
    console.log(
        `=== Topic ${destination.id} : ${destination.name} ===`
    );

    const inspected =
        await inspectTopic({
            id: destination.id,
            title: destination.name
        });

    if (
        !inspected ||
        !inspected.lastPid
    ) {
        return;
    }

    const oldTopic =
        state.topics[
            destination.id
        ];

    /*
     * Première exécution :
     * mémorise sans notifier.
     */

    if (
        !state.initialized
    ) {
        newState.topics[
            destination.id
        ] = {
            title:
                inspected.title,

            lastPid:
                inspected.lastPid
        };

        return;
    }

    /*
     * Si l'ancien état n'existe pas,
     * on initialise simplement ce topic.
     */

    if (!oldTopic) {
        newState.topics[
            destination.id
        ] = {
            title:
                inspected.title,

            lastPid:
                inspected.lastPid
        };

        return;
    }

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
            `Nouvelle réponse PID ${post.pid} dans topic ${destination.id}`
        );

        await sendNewReply(
            destination,
            inspected,
            post
        );
    }

    newState.topics[
        destination.id
    ] = {
        title:
            inspected.title,

        lastPid:
            inspected.lastPid
    };
}


/* =========================================================
   TEST DES WEBHOOKS
========================================================= */

async function runWebhookTests() {
    console.log(
        '=== Test des webhooks ==='
    );

    for (
        const forum
        of CONFIG.forums
    ) {
        console.log(
            `Test webhook : ${forum.name}`
        );

        await sendTestNotification({
            ...forum,
            type: 'forum'
        });
    }

    for (
        const topic
        of CONFIG.topics
    ) {
        console.log(
            `Test webhook : ${topic.name}`
        );

        await sendTestNotification({
            ...topic,
            type: 'topic'
        });
    }
}


/* =========================================================
   PROGRAMME
========================================================= */

async function main() {
    console.log(
        '=== Stella Cinis Discord ==='
    );

    validateWebhooks();

    /*
     * Si tu coches le test dans GitHub Actions,
     * les 5 webhooks reçoivent chacun un message.
     */

    if (
        process.env.TEST_NOTIFICATION === '1'
    ) {
        await runWebhookTests();
    }

    const state =
        await readState();

    const newState = {
        initialized: true,

        forums: {
            ...state.forums
        },

        topics: {
            ...state.topics
        }
    };

    /*
     * Surveiller les 4 forums.
     */

    for (
        const forum
        of CONFIG.forums
    ) {
        try {
            await processForum(
                forum,
                state,
                newState
            );

        } catch (error) {
            console.error(
                `Erreur forum ${forum.id}:`,
                error
            );
        }
    }

    /*
     * Surveiller les topics précis.
     */

    for (
        const destination
        of CONFIG.topics
    ) {
        try {
            await processSingleTopic(
                destination,
                state,
                newState
            );

        } catch (error) {
            console.error(
                `Erreur topic ${destination.id}:`,
                error
            );
        }
    }

    await writeState(
        newState
    );

    console.log('');
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
