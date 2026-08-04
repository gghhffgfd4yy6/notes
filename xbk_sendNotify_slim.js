'use strict';

// 精简版推送模块
// 仅保留：PushPlus、Server酱、Bark、PushMe、企业微信机器人、wxpusher、息知、PushDeer

const got = require('got');
const timeout = 15000;

// 日志密钥脱敏：保留前4位+后2位，中间 ***（防止 cron 日志重定向/分享时泄露密钥）
function maskKey(k) {
    const s = String(k === undefined || k === null ? '' : k);
    return s.length <= 6 ? '***' : s.slice(0, 4) + '***' + s.slice(-2);
}
// URL 脱敏：host 保留，路径/设备码段脱敏（Bark 的 api.day.app/deviceKey）
function maskUrl(u) {
    const s = String(u === undefined || u === null ? '' : u);
    const m = s.match(/^(https?:\/\/[^/]+)\/(.+)$/);
    return m ? m[1] + '/' + maskKey(m[2]) : maskKey(s);
}
// 代理对安全截断（v3.147）：按码元截断但不切断 emoji——末尾高代理退一位、孤立低代理退一位
// （Server酱 v3.126 只处理高代理；此处统一高/低代理，wxpusher summary 复用）
// v3.178：与主代码 truncateUtf16 对齐——补 ZWJ/变体选择符/组合字符退位（wxpusher summary/TG 截断
// 曾拆散 👨👩👧👦 家庭 emoji、❤️ 丢 VS16；§12-2 重复实现收敛）
function safeSlice(s, max) {
    let str;
    try { str = String(s === undefined || s === null ? '' : s); } catch (e) { str = ''; }
    if (str.length <= max) return str;
    let cut = str.slice(0, max);
    const isModifier = (c) => c === 0x200D || (c >= 0xFE00 && c <= 0xFE0F)
        || (c >= 0x0300 && c <= 0x036F) || (c >= 0x1AB0 && c <= 0x1AFF) || (c >= 0x1DC0 && c <= 0x1DFF)
        || (c >= 0x20D0 && c <= 0x20FF) || (c >= 0xFE20 && c <= 0xFE2F);
    while (cut.length > 0) {
        const last = cut.charCodeAt(cut.length - 1);
        if (last >= 0xD800 && last <= 0xDBFF) { cut = cut.slice(0, -1); continue; } // 孤立高代理
        if (last >= 0xDC00 && last <= 0xDFFF) {
            const prev = cut.charCodeAt(cut.length - 2);
            if (!(prev >= 0xD800 && prev <= 0xDBFF)) { cut = cut.slice(0, -1); continue; } // 孤立低代理
            break; // 配对完整
        }
        if (last === 0x200D) { cut = cut.slice(0, -1); continue; } // 末尾孤立 ZWJ
        const next = str.charCodeAt(cut.length);
        if (isModifier(next)) { cut = cut.slice(0, -1); continue; } // 截断点后是修饰符 → 退位
        break;
    }
    return cut;
}
// 错误摘要（v3.75）：失败日志统一打摘要而非整个 err 对象——
// $.post 回调的 err 是 err.response.body（API 异常响应体，可能回显请求参数含密钥），
// 直接 console.log(err) 会在 cron 日志重定向/分享时泄露；截断 200 字符防超长刷屏
function safeErr(e) {
    if (e === undefined || e === null) return '';
    if (typeof e === 'string') return e.length > 200 ? e.slice(0, 200) + '…' : e;
    if (e && e.message) return String(e.message).slice(0, 200);
    // 只保留协议错误摘要字段，禁止把服务端完整响应（可能回显 token/key/请求体）写入日志。
    // 未知结构不再 JSON.stringify 全对象，避免敏感字段通过兜底路径泄露。
    if (typeof e === 'object') {
        const fields = ['code', 'errno', 'errcode', 'error_code', 'statusCode', 'message', 'msg', 'errmsg', 'description', 'error'];
        const summary = {};
        for (const key of fields) {
            try {
                if (e[key] !== undefined && e[key] !== null) summary[key] = String(e[key]);
            } catch (err) { /* getter 异常字段跳过 */ }
        }
        let s;
        try { s = Object.keys(summary).length ? JSON.stringify(summary) : '[响应结构异常]'; }
        catch (err) { s = '[响应结构异常]'; }
        return s.length > 200 ? s.slice(0, 200) + '…' : s;
    }
    return String(e).slice(0, 200);
}

const push_config = {
    // 以下真实密钥由 push_config.local.js 提供（已被 .gitignore 忽略，不入库）

    HITOKOTO: 'false', // 启用一言（随机句子）

    // BARK_PUSH：Bark 地址或设备码，例：https://api.day.app/DxHcxxxxxRxxxxxxcm/
    //用 # 分隔多个设备码，例如：deviceKey1#deviceKey2#https://api.day.app/deviceKey3
    BARK_PUSH: '',
    BARK_ARCHIVE: '', // bark 推送是否存档
    BARK_GROUP: '', // bark 推送分组
    BARK_SOUND: '', // bark 推送声音
    BARK_ICON: '', // bark 推送图标
    BARK_LEVEL: '', // bark 推送时效性
    BARK_URL: '', // bark 推送跳转URL



    // 推送到个人QQ：http://127.0.0.1/send_private_msg
    // 群：http://127.0.0.1/send_group_msg
    // 推送到个人QQ 填入 user_id=个人QQ
    // 群 填入 group_id=QQ群



    PUSH_KEY: '', // server 酱的 PUSH_KEY(原真实key已移除,请自行配置), 兼容旧版与 Turbo 版

    DEER_KEY: '', // PushDeer 的 PUSHDEER_KEY
    DEER_URL: '', // PushDeer 的 PUSHDEER_URL


    // 官方文档：http://www.pushplus.plus/
    PUSH_PLUS_TOKEN: '', // push+ 微信推送的用户令牌
    PUSH_PLUS_USER: '', // push+ 微信推送的群组编码


    //wxpusher 文档：https://wxpusher.zjiecode.com/docs/
    //注意wxpusher填写的是主题ID，而不是用户ID
    WX_pusher_appToken: '', // wxpusher appToken(真实token已移除,请自行配置)
    WX_pusher_topicIds: '', // wxpusher 主题ID(真实ID已移除)

    //息知文档：https://xz.qqoq.net/
    //推送地址示例：https://xizhi.qqoq.net/xxxxxxxxxxxxx.send
    WX_XIZHI_KEY: '',


    //Pushme 安卓APP 官方文档：https://push.i-i.me
    PUSHME_URL: 'https://push.i-i.me',
    PUSHME_KEY: '', //PushMe 的 PUSHME_KEY(真实key已移除,请自行配置)，多个用#分割

    //MeoW 文档：https://www.chuckfang.com/MeoW/api_doc.html
    //用户昵称，例如这里面的昵称 http://api.chuckfang.com/昵称/
    //用 # 分隔多个用户ID，例如：user1#user2#user3

    // 微加机器人，官方网站：https://www.weplusbot.com/


    QYWX_ORIGIN: 'https://qyapi.weixin.qq.com', // 企业微信代理地址
    // 企业微信应用/企业家校推送
    /*
      此处QYWX_AM填你企业微信应用消息的值 https://new.xianbao.fun/jiaocheng/505380.html  https://new.xianbao.fun/jiaocheng/566777.html
      微信应用推送(第四个参数为yy)： QYWX_AM依次填入 企业ID,应用Agentld,应用Secret,yy
      微信家校推送(第四个参数为jx)： QYWX_AM依次填入 企业ID,应用Agentld,应用Secret,jx
      如需推送多个企业微信应用，请增加一项json
      */

    // 企业微信应用/企业家校推送

    

    QYWX_KEY: '', // 企业微信机器人的 webhook(详见文档 https://work.weixin.qq.com/api/doc/90000/90136/91770)，例如：693a91f6-7xxx-4bc4-97a0-0ec2sifa5aaa

    TG_BOT_TOKEN: '', // tg 机器人的 TG_BOT_TOKEN，例：1407203283:AAG9rt-6RDaaX0HBLZQq0laNOh898iFYaRQ
    TG_USER_ID: '', // tg 机器人的 TG_USER_ID，例：1434078534
    TG_API_HOST: 'https://api.telegram.org', // tg 代理 api
    TG_PROXY_AUTH: '', // tg 代理认证参数
    TG_PROXY_HOST: '', // tg 机器人的 TG_PROXY_HOST
    TG_PROXY_PORT: '', // tg 机器人的 TG_PROXY_PORT



    // CHRONOCAT API https://chronocat.vercel.app/install/docker/official/

};

// 加载本地推送配置（含真实密钥，不入库）：若 push_config.local.js 存在则覆盖默认空配置
// 文件不存在 = 正常（默认空配置，克隆者需自行创建）；存在但加载失败 = 显式警告（避免密钥静默失效）
const fs = require('fs');
const path = require('path');
const localPath = path.join(__dirname, 'push_config.local.js');
if (fs.existsSync(localPath)) {
    try {
        const localCfg = require(localPath);
        if (localCfg && typeof localCfg === 'object') {
            Object.assign(push_config, localCfg);
        } else {
            console.warn('⚠️ push_config.local.js 导出格式异常（应为对象），推送密钥可能未生效');
        }
    } catch (e) {
        console.warn('⚠️ push_config.local.js 加载失败（推送密钥可能未生效）:', e && e.message ? e.message : String(e));
    }
}

async function one() {
    const url = 'https://v1.hitokoto.cn/';
    // v3.151：3s 短超时——一言是推送装饰，API 慢/挂时不应阻塞推送（曾默认 15s，启用 HITOKOTO 用户每次推送延迟）
    const res = await got.get(url, { timeout: 3000 });
    // body 兼容：自制 got 已自动 JSON 解析为对象；字符串时手动解析
    const body = typeof res.body === 'string' ? JSON.parse(res.body) : res.body;
    // 防御（v3.86）：响应结构异常（缺 hitokoto/from）→ 抛错走 sendNotify 的 catch 跳过，
    // 避免输出 'undefined    ----undefined' 垃圾文本
    if (!body || typeof body.hitokoto !== 'string' || !body.hitokoto) {
        throw new Error('一言响应结构异常');
    }
    return `${body.hitokoto}    ----${body.from || ''}`; // v3.87: from 缺失不输出 undefined 残尾
}


const $ = {
    post: (params, callback) => {
        const { url, ...others } = params;
        got.post(url, others).then(
            (res) => {
                let body = res.body;
                try {
                    body = JSON.parse(body);
                } catch (error) {
                    // 预期路径：非 JSON 响应（HTML/文本）保留原始字符串，供各通道按需解析
                }
                callback(null, res, body);
            },
            (err) => {
                // v3.75：失败时传 Error 对象而非响应体——API 异常响应体可能回显请求参数（含密钥），
                // 且各通道失败日志已统一 safeErr 摘要（打 message 不含响应内容）
                callback(err || new Error('请求失败'));
            },
        );
    },
    get: (params, callback) => {
        const { url, ...others } = params;
        got.get(url, others).then(
            (res) => {
                let body = res.body;
                try {
                    body = JSON.parse(body);
                } catch (error) {
                    // 预期路径：非 JSON 响应（HTML/文本）保留原始字符串，供各通道按需解析
                }
                callback(null, res, body);
            },
            (err) => {
                // v3.75：失败时传 Error 对象而非响应体——API 异常响应体可能回显请求参数（含密钥），
                // 且各通道失败日志已统一 safeErr 摘要（打 message 不含响应内容）
                callback(err || new Error('请求失败'));
            },
        );
    },
    logErr: console.log,
};

function pushPlusNotify(text, desp) {
    return new Promise((resolve, reject) => {
        const { PUSH_PLUS_TOKEN, PUSH_PLUS_USER } = push_config;
        if (PUSH_PLUS_TOKEN) {
            desp = mdToPlain(desp); // v3.128：Push+ 默认 html，markdown 符号会原样显示
            desp = desp.replace(/[\n\r]/g, '<br>'); // 默认为html, 不支持plaintext
            const body = {
                token: `${PUSH_PLUS_TOKEN}`,
                title: `${text}`,
                content: `${desp}`,
                topic: `${PUSH_PLUS_USER}`,
            };
            const options = {
                url: `https://www.pushplus.plus/send`,
                body: JSON.stringify(body),
                headers: {
                    'Content-Type': 'application/json',
                },
                timeout,
            };
            $.post(options, (err, resp, data) => {
                try {
                    if (err) {
                    reject(err);
                        console.log(
                            `Push+ 发送${PUSH_PLUS_USER ? '一对多' : '一对一'
                            }通知消息失败😞\n`,
                            safeErr(err),
                        );
                    } else {
                        // v3.180：data 判空防御——HTTP 200 + 响应体 JSON null 时 data.code 曾抛
                        // TypeError → catch 只记日志 → finally resolve(data) 虚假成功 → 主流程写缓存
                        // → 消息永久丢失（系统验证实测确认，P1）
                        if (data && data.code === 200) {
                            console.log(
                                `Push+ 发送${PUSH_PLUS_USER ? '一对多' : '一对一'
                                }通知消息完成🎉\n`,
                            );
                        } else {
                            console.log(
                                `Push+ 发送${PUSH_PLUS_USER ? '一对多' : '一对一'
                                }通知消息异常 ${data && data.msg ? data.msg : ''}\n`,
                            ); // v3.180：data.msg 也判空——null 时模板访问曾二次抛错走 catch→虚假成功
                            // v3.160：API 级失败(code≠200) reject（与 wxpusher v3.154 同口径）——曾静默 resolve，
                            // 单通道用户主流程写缓存 → 消息永久丢失
                            reject(new Error(data && data.msg ? data.msg : 'Push+ 发送失败'));
                        }
                    }
                } catch (e) {
                    $.logErr(e, resp);
                } finally {
                    resolve(data);
                }
            });
        } else {
            resolve();
        }
    });
}

function serverNotify(text, desp) {
    return new Promise((resolve, reject) => {
        const { PUSH_KEY } = push_config;
        if (PUSH_KEY) {
            // v3.176：PUSH_KEY 数字/对象脏配置 → String 化（曾 .includes 抛 TypeError 通道静默失败）
            const pushKey = String(PUSH_KEY);
            // v3.126：Server酱 title 上限 32 字符——主代码 titleMax=100 不满足，此处通道层精准截断
            // （安全处理代理对：末尾高代理退一位，避免切坏 emoji）
            if (text.length > 32) {
                let cut = text.slice(0, 32);
                const last = cut.charCodeAt(cut.length - 1);
                if (last >= 0xD800 && last <= 0xDBFF) cut = cut.slice(0, -1);
                text = cut;
            }
            // 微信server酱推送通知一个\n不会换行，需要两个\n才能换行，故做此替换
            // v3.148：只加倍"单个 \n"——\n\n（Markdown 段落分隔）已是 Server酱换行格式，曾整体加倍成 \n\n\n\n 大段空白
            desp = desp.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/([^\n])\n(?!\n)/g, '$1\n\n');
            const options = {
                url: pushKey.includes('SCT')
                    ? `https://sctapi.ftqq.com/${pushKey}.send`
                    : `https://sc.ftqq.com/${pushKey}.send`,
                body: `text=${encodeURIComponent(text)}&desp=${encodeURIComponent(desp)}`,
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                },
                timeout,
            };
            $.post(options, (err, resp, data) => {
                try {
                    if (err) {
                    reject(err);
                        console.log('Server 酱发送通知调用API失败😞\n', safeErr(err));
                    } else {
                        // server酱和Server酱·Turbo版的返回json格式不太一样
                        // 响应防御：Server酱/Turbo 返回结构不同，且异常时可能缺字段
                        const errno = data && (data.errno !== undefined ? data.errno : (data.data && data.data.errno));
                        if (errno === 0) {
                            console.log('Server 酱发送通知消息成功🎉\n');
                        } else if (errno === 1024) {
                            // 一分钟内发送相同的内容会触发（内容已送达，视为成功不重试）
                            console.log(`Server 酱发送通知消息异常 ${data.errmsg}\n`);
                        } else {
                            console.log(`Server 酱发送通知消息异常 ${safeErr(data)}\n`);
                            // v3.160：API 级失败(errno≠0/1024) reject——曾静默 resolve 致单通道用户消息丢失
                            reject(new Error(data && data.errmsg ? data.errmsg : 'Server酱 发送失败'));
                        }
                    }
                } catch (e) {
                    $.logErr(e, resp);
                } finally {
                    resolve(data);
                }
            });
        } else {
            resolve();
        }
    });
}

function barkNotify(text, desp, params = {}) {
    return new Promise((resolve, reject) => {
        let {
            BARK_PUSH,
            BARK_ICON,
            BARK_SOUND,
            BARK_GROUP,
            BARK_LEVEL,
            BARK_ARCHIVE,
            BARK_URL,
        } = push_config;

        if (!BARK_PUSH) {
            return resolve();
        }
        desp = mdToPlain(desp); // v3.128：Bark iOS 纯文本，markdown 符号会原样显示

        // 分割多个设备码
        // v3.176：BARK_PUSH 数字/对象脏配置 → String 化（曾 .split 抛 TypeError 通道静默失败）
        const deviceKeys = String(BARK_PUSH).split('#').filter(key => key.trim());
        if (deviceKeys.length === 0) {
            return resolve();
        }

        // 处理所有设备推送
        const pushPromises = deviceKeys.map(deviceKey => {
            let pushUrl = deviceKey.trim();
            // 兼容BARK本地用户只填写设备码的情况
            if (!pushUrl.startsWith('http')) {
                pushUrl = `https://api.day.app/${pushUrl}`;
            }

            const options = {
                url: pushUrl,
                json: {
                    title: text,
                    body: desp,
                    icon: BARK_ICON,
                    sound: BARK_SOUND,
                    group: BARK_GROUP,
                    isArchive: BARK_ARCHIVE,
                    level: BARK_LEVEL,
                    url: BARK_URL,
                    ...params,
                },
                headers: {
                    'Content-Type': 'application/json',
                },
                timeout,
            };

            return new Promise((innerResolve) => {
                $.post(options, (err, resp, data) => {
                    try {
                        if (err) {
                            console.log(`Bark APP 发送通知到 ${maskUrl(pushUrl)} 失败😞\n`, safeErr(err));
                            innerResolve({ ok: false });
                        } else {
                            // data 判空：HTTP 200 + JSON null 时不依赖 catch 兜底，避免 TypeError 噪音
                            if (data && data.code === 200) {
                                console.log(`Bark APP 发送通知到 ${maskUrl(pushUrl)} 成功🎉\n`);
                                innerResolve({ ok: true });
                            } else {
                                console.log(`Bark APP 发送通知到 ${maskUrl(pushUrl)} 异常 ${data.message}\n`);
                                // v3.166：单设备失败不拖垮整体——多设备（# 分割）一个失效时，
                                // 曾外层 reject → 有效设备已收到但通道整体失败 → 不写缓存 → 每次运行重试 → 有效设备重复轰炸
                                innerResolve({ ok: false });
                            }
                        }
                    } catch (e) {
                        $.logErr(e, resp);
                        innerResolve({ ok: false });
                    } finally {
                        innerResolve({ ok: false });
                    }
                });
            });
        });

        // 等待所有推送完成
        // v3.166：至少一个设备成功 = 通道成功（与 sendNotify allSettled 哲学一致）——全部失败才 reject
        Promise.all(pushPromises).then(results => {
            if (results.some(r => r && r.ok)) resolve();
            else reject(new Error('Bark 全部设备发送失败'));
        });
    });
}

function pushMeNotify(text, desp, params = {}) {
    return new Promise((resolve, reject) => {
        const { PUSHME_KEY, PUSHME_URL } = push_config;

        if (!PUSHME_KEY) {
            return resolve();
        }

        // 分割多个推送KEY
        // v3.176：PUSHME_KEY 数字/对象脏配置 → String 化（曾 .split 抛 TypeError 通道静默失败）
        const pushKeys = String(PUSHME_KEY).split('#').filter(key => key.trim());
        if (pushKeys.length === 0) {
            return resolve();
        }

        // 处理所有推送请求
        const pushPromises = pushKeys.map(pushKey => {
            const trimmedKey = pushKey.trim();
            const options = {
                url: PUSHME_URL || 'https://push.i-i.me',
                json: {
                    push_key: trimmedKey,
                    title: text,
                    content: desp,
                    type: "markdown",
                    ...params
                },
                headers: {
                    'Content-Type': 'application/json',
                },
                timeout,
            };

            return new Promise((innerResolve) => {
                $.post(options, (err, resp, data) => {
                    try {
                        if (err) {
                            console.log(`PushMe 发送通知到 KEY ${maskKey(trimmedKey)} 失败😞\n`, safeErr(err));
                            innerResolve({ ok: false });
                        } else {
                            if (data === 'success') {
                                console.log(`PushMe 发送通知到 KEY ${maskKey(trimmedKey)} 成功🎉\n`);
                                innerResolve({ ok: true });
                            } else {
                                console.log(`PushMe 发送通知到 KEY ${maskKey(trimmedKey)} 异常: ${data}\n`);
                                // v3.166：单 key 失败不拖垮整体——多 key（# 分割）一个失效时，
                                // 曾外层 reject → 有效 key 已收到但通道整体失败 → 不写缓存 → 每次运行重试 → 有效 key 重复轰炸
                                innerResolve({ ok: false });
                            }
                        }
                    } catch (e) {
                        $.logErr(e, resp);
                        innerResolve({ ok: false });
                    } finally {
                        innerResolve({ ok: false });
                    }
                });
            });
        });

        // 等待所有推送完成
        // v3.166：至少一个 key 成功 = 通道成功（与 sendNotify allSettled 哲学一致）——全部失败才 reject
        Promise.all(pushPromises).then(results => {
            if (results.some(r => r && r.ok)) resolve();
            else reject(new Error('PushMe 全部 key 发送失败'));
        });
    });
}

function qywxBotNotify(text, desp) {
    return new Promise((resolve, reject) => {
        const { QYWX_ORIGIN, QYWX_KEY } = push_config;
        const options = {
            url: `${String(QYWX_ORIGIN || 'https://qyapi.weixin.qq.com').replace(/\/+$/, '')}/cgi-bin/webhook/send?key=${QYWX_KEY}`, // v3.138：去尾斜杠防双斜杠
            json: {
                // v3.127：msgtype 'text' → 'markdown'——desp 是 Markdown 内容，text 模式会显示 ** 等原始符号（企微支持 markdown）
                msgtype: 'markdown',
                markdown: {
                    // v3.130：企微 markdown 不支持图片——真实接口 desp 全含 ![]()，剥成 alt 文本（保留粗体/链接等其他语法）
                    // v3.139：企微 markdown content 上限约 4096 字节——contentMax=3000 字符(中文 9000 字节)可能超，按字节截断(代理对安全)
                    content: truncateBytes(desp ? `${text}\n\n${String(desp).replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_, alt) => alt || '(图片)')}` : text, 4096),
                },
            },
            headers: {
                'Content-Type': 'application/json',
            },
            timeout,
        };
        if (QYWX_KEY) {
            $.post(options, (err, resp, data) => {
                try {
                    if (err) {
                    reject(err);
                        console.log('企业微信发送通知消息失败😞\n', safeErr(err));
                    } else {
                        // v3.180：data 判空防御（同 Push+，HTTP 200 + JSON null 曾虚假成功）
                        if (data && data.errcode === 0) {
                            console.log('企业微信发送通知消息成功🎉。\n');
                        } else {
                            console.log(`企业微信发送通知消息异常 ${data && data.errmsg ? data.errmsg : ''}\n`); // v3.180：errmsg 判空（同 Push+ else 分支）
                            // v3.160：API 级失败(errcode≠0) reject——曾静默 resolve 致单通道用户消息丢失
                            reject(new Error(data && data.errmsg ? data.errmsg : '企业微信 发送失败'));
                        }
                    }
                } catch (e) {
                    $.logErr(e, resp);
                } finally {
                    resolve(data);
                }
            });
        } else {
            resolve();
        }
    });
}

// v3.159：wxpusher 内容类型自适应——contentType=3(Markdown) 不渲染 HTML 源码（{Html内容} 模板时内容裸露 <br>/<a href>）
// 含真实 HTML 标签时自动切 contentType=2(HTML 渲染)；标签白名单避免误判 Markdown 的 <https://...> autolink
function looksHtml(s) {
    if (!s || typeof s !== 'string') return false;
    return /<\s*\/?\s*(?:br|a|img|p|div|strong|b|i|em|u|s|table|tr|td|th|ul|ol|li|h[1-6]|span|font|blockquote|code|pre|hr)\b[^>]*>/i.test(s);
}

function wxPusherNotify(text, desp) {
    return new Promise((resolve, reject) => {
        const { WX_pusher_appToken, WX_pusher_topicIds } =
            push_config;

        const options = {
            url: `https://wxpusher.zjiecode.com/api/send/message`,
            json: {
                appToken: WX_pusher_appToken,
                content: desp,
                summary: safeSlice(text, 90),
                // v3.159：内容含 HTML 标签时用 contentType=2（HTML 渲染）——Markdown(3) 会把 <br>/<a> 当纯文本裸露
                contentType: looksHtml(desp) ? 2 : 3, // 1文字 2HTML 3Markdown
                // v3.137：配置注释"多个用逗号分隔"但未分割——[WX_pusher_topicIds] 曾发 ['1,2'] 而非 ['1','2']，多主题失效
                topicIds: String(WX_pusher_topicIds || '').split(',').map(s => s.trim()).filter(Boolean),
            },
            headers: {
                'Content-Type': 'application/json',
            },
            timeout,
        };

        if (WX_pusher_appToken) {
            $.post(options, (err, resp, data) => {
                try {
                    if (err) {
                    reject(err);
                        console.log('WxPusher发送通知消息失败😞\n', safeErr(err));
                    } else {
                        // v3.180：data 判空防御（同 Push+，HTTP 200 + JSON null 曾虚假成功）
                        if (data && data.code === 1000) {
                            console.log('WxPusher发送通知消息成功🎉。\n'); // v3.154：恢复成功日志（曾注释——单通道用户无法确认推送）
                        } else {
                            console.log(`WxPusher发送通知消息异常\n`);
                            // 打印响应摘要（不打印完整对象——异常响应可能回显请求参数含 token）
                            console.log(safeErr(data));
                            // v3.154：API 级失败(code≠1000)也 reject——曾 resolve 静默，单通道用户
                            // （如只保留 wxpusher）主流程会写缓存 → 消息永久丢失（下次去重跳过）
                            reject(new Error(data && data.msg ? data.msg : 'wxpusher 发送失败'));
                        }
                    }
                } catch (e) {
                    $.logErr(e, resp);
                } finally {
                    resolve(data);
                }
            });

        } else {
            resolve();
        }
    });
}

function wxXiZhiNotify(text, desp) {
    return new Promise((resolve, reject) => {
        const { WX_XIZHI_KEY } =
            push_config;

        const options = {
            url: WX_XIZHI_KEY,
            json: {
                title: text,
                content: desp
            },
            headers: {
                'Content-Type': 'application/json',
            },
            timeout,
        };

        if (WX_XIZHI_KEY) {
            $.post(options, (err, resp, data) => {
                try {
                    if (err) {
                    reject(err);
                        console.log('息知发送通知消息失败😞\n', safeErr(err));
                    } else {
                        // v3.180：data 判空防御（同 Push+，HTTP 200 + JSON null 曾虚假成功）
                        if (data && data.code === 200) {
                            console.log('息知发送通知消息成功🎉。\n');
                        } else {
                            console.log(`息知发送通知消息异常 \n`);
                            // 打印响应摘要（不打印完整对象——异常响应可能回显请求参数）
                            console.log(safeErr(data));
                            // v3.160：API 级失败(code≠200) reject——曾静默 resolve 致单通道用户消息永久丢失
                            reject(new Error(data && data.msg ? data.msg : '息知 发送失败'));
                        }
                    }
                } catch (e) {
                    $.logErr(e, resp);
                } finally {
                    resolve(data);
                }
            });

        } else {
            resolve();
        }
    });
}

function pushDeerNotify(text, desp) {
    return new Promise((resolve, reject) => {
        const { DEER_KEY, DEER_URL } = push_config;
        if (DEER_KEY) {
            // PushDeer 建议对消息内容进行 urlencode（encodeURI 不编码 & = #，需 encodeURIComponent）
            const enc = (s) => encodeURIComponent(s);
            const options = {
                url: DEER_URL || `https://api2.pushdeer.com/message/push`,
                body: `pushkey=${enc(DEER_KEY)}&text=${enc(text)}&desp=${enc(desp)}&type=markdown`,
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                },
                timeout,
            };
            $.post(options, (err, resp, data) => {
                try {
                    if (err) {
                    reject(err);
                        console.log('PushDeer 通知调用API失败😞\n', safeErr(err));
                    } else {
                        // 通过返回的result的长度来判断是否成功（响应防御：异常时可能缺 content/result 字段）
                        if (
                            data && data.content && data.content.result &&
                            data.content.result.length !== undefined &&
                            data.content.result.length > 0
                        ) {
                            console.log('PushDeer 发送通知消息成功🎉\n');
                        } else {
                            console.log(
                                `PushDeer 发送通知消息异常😞 ${safeErr(data)}\n`,
                            );
                            // v3.160：API 级失败(result 空) reject——曾静默 resolve 致单通道用户消息丢失
                            reject(new Error('PushDeer 发送失败'));
                        }
                    }
                } catch (e) {
                    $.logErr(e, resp);
                } finally {
                    resolve(data);
                }
            });
        } else {
            resolve();
        }
    });
}


// 模块级：TG_PROXY 未实现警告只提示一次（防每次推送刷屏）
let tgProxyWarned = false;

function tgNotify(text, desp) {
    return new Promise((resolve, reject) => {
        const { TG_BOT_TOKEN, TG_USER_ID, TG_API_HOST } = push_config;
        // TG_PROXY_* 保留配置项：自制 got 不支持 http 代理（v3.76 一次性警告防误配静默失效）
        if (!tgProxyWarned && (push_config.TG_PROXY_HOST || push_config.TG_PROXY_PORT)) {
            tgProxyWarned = true;
            console.warn('⚠️ 配置了 TG_PROXY_HOST/PORT，但自制 got 不支持 http 代理，该配置不生效；需要代理请改用 TG_API_HOST 指向代理网关');
        }
        if (TG_BOT_TOKEN && TG_USER_ID) {
            // v3.132：parse_mode 'Markdown' → 'HTML'——真实接口 20 条中 19 条含 markdown 特殊字符、
            // 1 条含未配对 *（TG Markdown 对未配对 * 报错发送失败）；改 HTML 模式 + 剥 markdown 符号
            // + 转义 & < >（HTML 只对这 3 个敏感，无报错、无乱码，纯文本显示）
            const tgText = mdToPlain(text, false);
            const tgDesp = mdToPlain(desp, false); // v3.136：TG 保留 < >（HTML 转义），不剥 autolink
            const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
            // v3.139：TG 消息上限 4096 字符——内容超长截断（v3.178：统一 safeSlice——曾内联只处理
            // 高代理，孤立低代理/ZWJ/VS16 会残留乱码；§12-4 重复实现收敛）
            const tgFull = esc(tgDesp ? `${tgText}\n\n${tgDesp}` : tgText);
            const tgSafe = tgFull.length > 4000 ? safeSlice(tgFull, 4000) : tgFull;
            const options = {
                url: `${String(TG_API_HOST || 'https://api.telegram.org').replace(/\/+$/, '')}/bot${TG_BOT_TOKEN}/sendMessage`, // v3.138：去尾斜杠防双斜杠
                json: {
                    chat_id: TG_USER_ID,
                    text: tgSafe,
                    parse_mode: 'HTML',
                    disable_web_page_preview: true,
                },
                headers: {
                    'Content-Type': 'application/json',
                },
                timeout,
            };
            $.post(options, (err, resp, data) => {
                try {
                    if (err) {
                    reject(err);
                        console.log('Telegram 发送通知消息失败😞\n', safeErr(err));
                    } else {
                        if (data && data.ok === true) {
                            console.log('Telegram 发送通知消息成功🎉\n');
                        } else {
                            console.log(`Telegram 发送通知消息异常 ${safeErr(data)}\n`);
                            // v3.160：API 级失败(ok≠true) reject——曾静默 resolve 致单通道用户消息丢失
                            reject(new Error(data && data.description ? data.description : 'Telegram 发送失败'));
                        }
                    }
                } catch (e) {
                    $.logErr(e, resp);
                } finally {
                    resolve(data);
                }
            });
        } else {
            resolve();
        }
    });
}

// 按 UTF-8 字节截断（v3.139：企微 markdown content 4096 字节上限；代理对安全——末尾高代理退一位）
function truncateBytes(s, maxBytes) {
    let str = String(s === undefined || s === null ? '' : s);
    if (Buffer.byteLength(str, 'utf8') <= maxBytes) return str;
    let cut = str.slice(0, maxBytes); // 近似（UTF-8 多字节可能超）
    while (Buffer.byteLength(cut, 'utf8') > maxBytes) cut = cut.slice(0, -1);
    const last = cut.charCodeAt(cut.length - 1);
    if (last >= 0xD800 && last <= 0xDBFF) cut = cut.slice(0, -1); // 高代理退位
    return cut;
}

// markdown → 纯文本（v3.128：Bark/Push+ 不支持 markdown 渲染，desp 会显示 ** 等原始符号）
// v3.136：剥 <url> autolink 尖括号（stripAngle 默认 true）；TG 传 false（保留 < > 给 HTML 转义）
// v3.149：HTML 标签（含属性）整体剥空——{Html内容} 模板产物曾残留 'a href="..." target="_blank"' 垃圾文本；
//          <url> autolink（http 开头）保留内容；&nbsp; 等实体解码为空格
function mdToPlain(s, stripAngle = true) {
    return String(s === undefined || s === null ? '' : s)
        .replace(/\*\*([^*]+)\*\*/g, '$1')            // **粗体** → 粗体
        .replace(/(?<![0-9])\*([^*\n]+?)(?<![0-9])\*(?!\*)/g, '$1') // *斜体* → 斜体（v3.150：数字前后 * 不算斜体——'5*3*2cm' 曾误剥成 '532cm'）
        .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '$1')   // ![alt](url) → alt
        .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (m, t, u) => (t === u ? t : `${t} (${u})`)) // [text](url) → text (url)；v3.153：text===url(原文链接) 只显示一次
        .replace(/^#{1,6}\s+/gm, '')                  // # 标题
        .replace(/`([^`]+)`/g, '$1')                  // `代码` → 代码
        .replace(/<([^>]+)>/g, (m, inner) => {
            if (!stripAngle) return m; // TG：保留 <>（HTML 转义）
            const t = inner.trim();
            return /^https?:(\/\/)?/i.test(t) ? t : ''; // <url> autolink 保留内容；HTML 标签剥空
        })
        .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"').replace(/&#39;/g, "'"); // 实体解码（{Html内容} 的 &nbsp; 等）
}

// 孤立代理清洗（v3.110）：encodeURIComponent 对孤立代理抛 URIError——推送前统一处理
function cleanSurrogates(s) {
    try { s = String(s === undefined || s === null ? '' : s); } catch (e) { return ''; }
    return s.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '\uFFFD');
}

async function sendNotify(text, desp, params = {}) {
    // v3.110：入口统一清洗孤立代理（encodeURIComponent 对孤立代理抛 URIError → 通道发送失败）
    text = cleanSurrogates(text);
    desp = cleanSurrogates(desp);
    // 通道配置检查：一个都没配 → 拒绝（避免"静默成功"让主流程以为推送完成并写缓存）
    // 注意：这里必须与下方 Promise.all 实际调用的通道一一对应，漏一个就会让已配置的通道静默失效
    const hasChannel = push_config.PUSH_PLUS_TOKEN || push_config.PUSH_KEY || push_config.BARK_PUSH ||
        push_config.QYWX_KEY || push_config.WX_pusher_appToken || push_config.WX_XIZHI_KEY ||
        push_config.DEER_KEY || push_config.PUSHME_KEY ||
        (push_config.TG_BOT_TOKEN && push_config.TG_USER_ID);
    if (!hasChannel) {
        throw new Error('未配置任何推送通道（Push+/Server酱/Bark/企业微信/wxpusher/息知/PushDeer/PushMe/Telegram）');
    }
    // 一言开关按显式 true 开启；false/0/空值及其他非法值均关闭，兼容环境变量字符串。
    // 旧逻辑仅排除字符串 'false'，导致 HITOKOTO=0/'0'/undefined 时仍请求一言并额外增加延迟。
    const hitokotoEnabled = push_config.HITOKOTO === true ||
        (typeof push_config.HITOKOTO === 'string' && push_config.HITOKOTO.toLowerCase() === 'true');
    if (hitokotoEnabled) {
        if (typeof one === 'function') {
            try { desp += '\n\n' + (await one()); }
            catch (e) { console.log('一言获取失败，跳过:', e && e.message ? e.message : String(e)); }
        }
    }
    // v3.133：Promise.all → allSettled——单个通道失败不再整条失败；
    // 至少一个通道成功 = 成功（写缓存，失败的通道下次不重试防重复推送）；
    // 全部通道失败 = 抛错（主流程不写缓存，下次运行重试——防网络故障时消息丢失）
    const results = await Promise.allSettled([
        pushPlusNotify(text, desp, params),
        serverNotify(text, desp),
        barkNotify(text, desp, params),
        qywxBotNotify(text, desp),
        wxPusherNotify(text, desp),
        wxXiZhiNotify(text, desp),
        pushDeerNotify(text, desp),
        pushMeNotify(text, desp, params),
        tgNotify(text, desp, params),
    ]);
    // v3.133b：只统计"已配置"通道——未配置的通道 resolve（不参与），不掩盖已配置通道的失败
    const configuredFlags = [
        !!push_config.PUSH_PLUS_TOKEN, !!push_config.PUSH_KEY, !!push_config.BARK_PUSH,
        !!push_config.QYWX_KEY, !!push_config.WX_pusher_appToken, !!push_config.WX_XIZHI_KEY,
        !!push_config.DEER_KEY, !!push_config.PUSHME_KEY,
        !!(push_config.TG_BOT_TOKEN && push_config.TG_USER_ID),
    ];
    const attempted = results.filter((r, i) => configuredFlags[i]);
    const okCount = attempted.filter(r => r.status === 'fulfilled').length;
    if (attempted.length > 0 && okCount === 0) {
        const reasons = attempted.map(r => r.reason && r.reason.message ? r.reason.message : String(r.reason || '')).filter(Boolean).join('; ');
        throw new Error('所有推送通道失败: ' + reasons.slice(0, 200));
    }
}

module.exports = { sendNotify, push_config, maskKey, maskUrl, safeSlice };
