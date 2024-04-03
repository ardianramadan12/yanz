/**
 *  The MIT License (MIT)
 *  Copyright (c) 2024 by @xyzendev - Adriansyah
 *  © 2024 by @xyzendev - Adriansyah | MIT License
 */

import { baileys, fs, path, pino } from "@xyzendev/modules/core/main.modules.js";
import { parsePhoneNumber } from "libphonenumber-js"
import { fileTypeFromBuffer } from "file-type";
import { escapeRegExp } from "./Function.js"
import config from "../client/config.js";

const { jidNormalizedUser, extractMessageContent, areJidsSameUser, downloadMediaMessage, generateForwardMessageContent, generateWAMessageFromContent } = baileys;

export function getContentType(a) {
    if (a) {
        const keys = Object.keys(a);
        const key = keys.find(k => (k === 'conversation' || k.endsWith('Message') || k.includes('V2') || k.includes('V3')) && k !== 'senderKeyDistributionMessage');
        return key ? key : keys[0];
    }
}

export function Module({ xyzen, store }) {
    const client = Object.defineProperties(xyzen, {
        getName: {
            async value(jid) {
                let id = jidNormalizedUser(jid);
                if (id.endsWith("g.us")) {
                    let metadata = store.groupMetadata?.[id] || await xyzen.groupMetadata(id);
                    return metadata.subject;
                } else {
                    let metadata = store.contacts[id];
                    return (
                        metadata?.name ||
                        metadata?.verifiedName ||
                        metadata?.notify ||
                        parsePhoneNumber("+" + id.split("@")[0]).format("INTERNATIONAL")
                    );
                }
            }
        },

        sendContact: {
            async value(jid, number, quoted, options = {}) {
                let list = [];
                for (let v of number) {
                    if (v.endsWith("g.us")) continue;
                    v = v.replace(/\D+/g, "");
                    list.push({
                        displayName: await xyzen.getName(v + "@s.whatsapp.net"),
                        vcard: `BEGIN:VCARD\nVERSION:3.0\nN:${await xyzen.getName(v + "@s.whatsapp.net")}\nFN:${await xyzen.getName(v + "@s.whatsapp.net")}\nitem1.TEL;waid=${v}:${v}\nEND:VCARD`
                    });
                }
                return xyzen.sendMessage(jid, {
                    contacts: {
                        displayName: `${list.length} Contact`,
                        contacts: list
                    }
                }, { quoted, ...options });
            },
            enumerable: true
        },

        parseMention: {
            value(text) {
                return [...text.matchAll(/@([0-9]{5,16}|0)/g)].map(v => v[1] + '@s.whatsapp.net') || [];
            }
        },

        downloadMediaMessage: {
            async value(message, filename) {
                let media = await downloadMediaMessage(
                    message,
                    "buffer",
                    {},
                    {
                        logger: pino({ timestamp: () => `,"time":"${new Date().toJSON()}"`, level: "fatal" }).child({ class: "xyzen" }),
                        reuploadRequest: xyzen.updateMediaMessage
                    }
                );

                if (filename) {
                    let mime = await fileTypeFromBuffer(media);
                    let filePath = path.join(process.cwd(), `${filename}.${mime.ext}`);
                    fs.promises.writeFile(filePath, media);
                    return filePath;
                }

                return media;
            },
            enumerable: true
        },

        cMod: {
            value(jid, copy, text = '', sender = xyzen.user.id, options = {}) {
                let mtype = getContentType(copy.message);
                let content = copy.message[mtype];
                if (typeof content === "string") copy.message[mtype] = text || content;
                else if (content.caption) content.caption = text || content.caption;
                else if (content.text) content.text = text || content.text;
                if (typeof content !== "string") {
                    copy.message[mtype] = { ...content, ...options };
                    copy.message[mtype].contextInfo = {
                        ...(content.contextInfo || {}),
                        mentionedJid: options.mentions || content.contextInfo?.mentionedJid || []
                    };
                }
                if (copy.key.participant) sender = copy.key.participant = sender || copy.key.participant;
                if (copy.key.remoteJid.includes("@s.whatsapp.net")) sender = sender || copy.key.remoteJid;
                else if (copy.key.remoteJid.includes("@broadcast")) sender = sender || copy.key.remoteJid;
                copy.key.remoteJid = jid;
                copy.key.fromMe = areJidsSameUser(sender, xyzen.user.id);
                return baileys.proto.WebMessageInfo.fromObject(copy);
            },
            enumerable: false
        }
    });

    return client;
}


export default async function smsg(xyzen, msg, store) {
    try {
        const m = {};

        if (!msg.message) return

        if (!msg) return msg

        m.message = parseMessage(msg.message)

        if (msg.key) {
            m.key = msg.key
            m.from = m.key.remoteJid.startsWith("status") ? jidNormalizedUser(m.key.participant) : jidNormalizedUser(m.key.remoteJid)
            m.fromMe = m.key.fromMe
            m.id = m.key.id
            m.device = /^3A/.test(m.id) ? 'ios' : /^3E/.test(m.id) ? 'web' : /^.{21}/.test(m.id) ? 'android' : /^.{18}/.test(m.id) ? 'desktop' : 'unknown'
            m.isBot = (m.id.startsWith("BAE5") || m.id.startsWith("HSK"))
            m.isGroup = m.from.endsWith("@g.us")
            m.participant = jidNormalizedUser(msg?.participant || m.key.participant) || false
            m.sender = jidNormalizedUser(m.fromMe ? xyzen.user.id : m.isGroup ? m.participant : m.from)
        }

        if (m.isGroup) {
            m.metadata = store.groupMetadata[m.from] || await xyzen.groupMetadata(m.from)
            m.groupAdmins = m.isGroup && (m.metadata.participants.reduce((memberAdmin, memberNow) => (memberNow.admin ? memberAdmin.push({ id: memberNow.id, admin: memberNow.admin }) : [...memberAdmin]) && memberAdmin, []))
            m.isAdmin = m.isGroup && !!m.groupAdmins.find((member) => member.id === m.sender)
            m.isBotAdmin = m.isGroup && !!m.groupAdmins.find((member) => member.id === jidNormalizedUser(xyzen.user.id))
            m.participants = m.metadata.participants(a => a.id)
        }

        m.pushName = msg.pushName || m.sender
        m.isOwner = m.sender && config.number.number.includes(m.sender.replace(/\D+/g, ""))

        if (m.message) {
            m.type = getContentType(m.message) || Object.keys(m.message)[0]
            m.msg = parseMessage(m.message[m.type]) || m.message[m.type]
            m.mentions = [...(m.msg?.contextInfo?.mentionedJid || []), ...(m.msg?.contextInfo?.groupMentions?.map(v => v.groupJid) || [])]
            m.body = m.msg?.text || m.msg?.conversation || m.msg?.caption || m.message?.conversation || m.msg?.selectedButtonId || m.msg?.singleSelectReply?.selectedRowId || m.msg?.selectedId || m.msg?.contentText || m.msg?.selectedDisplayText || m.msg?.title || m.msg?.name || ""
            m.prefix = new RegExp(`^[°•π÷×¶∆£¢€¥®™+✓=|/~!?@#%^&.©^]`, "gi").test(m.body) ? m.body.match(new RegExp(`^[°•π÷×¶∆£¢€¥®™+✓=|/~!?@#%^&.©^]`, "gi"))[0] : ""
            m.command = m.body && m.body.trim().replace(m.prefix, '').trim().split(/ +/).shift()
            m.args = m.body.trim().replace(new RegExp("^" + escapeRegExp(m.prefix), 'i'), '').replace(m.command, '').split(/ +/).filter(a => a) || []
            m.text = m.args.join(" ").trim()
            m.expiration = m.msg?.contextInfo?.expiration || 0
            m.timestamps = (typeof msg.messageTimestamp === "number") ? msg.messageTimestamp * 1000 : m.msg.timestampMs * 1000
            m.isMedia = !!m.msg?.mimetype || !!m.msg?.thumbnailDirectPath
            m.isQuoted = false

            if (m.msg?.contextInfo?.quotedMessage) {
                m.isQuoted = true
                m.quoted = {}
                m.quoted.message = parseMessage(m.msg?.contextInfo?.quotedMessage)

                if (m.quoted.message) {
                    m.quoted.type = getContentType(m.quoted.message) || Object.keys(m.quoted.message)[0]
                    m.quoted.msg = parseMessage(m.quoted.message[m.quoted.type]) || m.quoted.message[m.quoted.type]
                    m.quoted.isMedia = !!m.quoted.msg?.mimetype || !!m.quoted.msg?.thumbnailDirectPath
                    m.quoted.key = {
                        remoteJid: m.msg?.contextInfo?.remoteJid || m.from,
                        participant: jidNormalizedUser(m.msg?.contextInfo?.participant),
                        fromMe: areJidsSameUser(jidNormalizedUser(m.msg?.contextInfo?.participant), jidNormalizedUser(xyzen?.user?.id)),
                        id: m.msg?.contextInfo?.stanzaId
                    }
                    m.quoted.from = /g\.us|status/.test(m.msg?.contextInfo?.remoteJid) ? m.quoted.key.participant : m.quoted.key.remoteJid
                    m.quoted.fromMe = m.quoted.key.fromMe
                    m.quoted.id = m.msg?.contextInfo?.stanzaId
                    m.quoted.device = /^3A/.test(m.quoted.id) ? 'ios' : /^3E/.test(m.quoted.id) ? 'web' : /^.{21}/.test(m.quoted.id) ? 'android' : /^.{18}/.test(m.quoted.id) ? 'desktop' : 'unknown'
                    m.quoted.isGroup = m.quoted.from.endsWith("@g.us")
                    m.quoted.participant = jidNormalizedUser(m.msg?.contextInfo?.participant) || false
                    m.quoted.sender = jidNormalizedUser(m.msg?.contextInfo?.participant || m.quoted.from)
                    m.quoted.mentions = [...(m.quoted.msg?.contextInfo?.mentionedJid || []), ...(m.quoted.msg?.contextInfo?.groupMentions?.map(v => v.groupJid) || [])]
                    m.quoted.body = m.quoted.msg?.text || m.quoted.msg?.caption || m.quoted?.message?.conversation || m.quoted.msg?.selectedButtonId || m.quoted.msg?.singleSelectReply?.selectedRowId || m.quoted.msg?.selectedId || m.quoted.msg?.contentText || m.quoted.msg?.selectedDisplayText || m.quoted.msg?.title || m.quoted?.msg?.name || ""
                    m.quoted.prefix = new RegExp(`^[°•π÷×¶∆£¢€¥®™+✓=|/~!?@#%^&.©^]`, "gi").test(m.quoted.body) ? m.quoted.body.match(new RegExp(`^[°•π÷×¶∆£¢€¥®™+✓=|/~!?@#%^&.©^]`, "gi"))[0] : ""
                    m.quoted.command = m.quoted.body && m.quoted.body.replace(m.quoted.prefix, '').trim().split(/ +/).shift()
                    m.quoted.args = m.quoted.body.trim().replace(new RegExp("^" + escapeRegExp(m.quoted.prefix), 'i'), '').replace(m.quoted.command, '').split(/ +/).filter(a => a) || []
                    m.quoted.text = m.quoted.args.join(" ").trim() || m.quoted.body
                    m.quoted.isOwner = m.quoted.sender && config.number.number.includes(m.quoted.sender.replace(/\D+/g, ""))
                }
            }
        }

        m.reply = async (text, options = {}) => {
            if (typeof text === "string") {
                return await xyzen.sendMessage(m.from, { text, ...options }, { quoted: m, ephemeralExpiration: m.expiration, ...options })
            } else if (typeof text === "object" && typeof text !== "string") {
                return xyzen.sendMessage(m.from, { ...text, ...options }, { quoted: m, ephemeralExpiration: m.expiration, ...options })
            }
        }

        return m;
    } catch (e) {
        console.error(e)
    }
}

function parseMessage(content) {
    content = extractMessageContent(content)

    if (content && content.viewOnceMessageV2Extension) {
        content = content.viewOnceMessageV2Extension.message
    }
    if (content && content.protocolMessage && content.protocolMessage.type == 14) {
        let type = getContentType(content.protocolMessage)
        content = content.protocolMessage[type]
    }
    if (content && content.message) {
        let type = getContentType(content.message)
        content = content.message[type]
    }

    return content
}