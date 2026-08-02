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
// 错误摘要（v3.75）：失败日志统一打摘要而非整个 err 对象——
// $.post 回调的 err 是 err.response.body（API 异常响应体，可能回显请求参数含密钥），
// 直接 console.log(err) 会在 cron 日志重定向/分享时泄露；截断 200 字符防超长刷屏
function safeErr(e) {
    if (e === undefined || e === null) return '';
    if (typeof e === 'string') return e.length > 200 ? e.slice(0, 200) + '…' : e;
    if (e && e.message) return String(e.message).slice(0, 200);
    let s;
    try { s = JSON.stringify(e); } catch (err) { s = String(e); }
    return s ? (s.length > 200 ? s.slice(0, 200) + '…' : s) : String(e);
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
    const res = await got.get(url);
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
                        if (data.code === 200) {
                            console.log(
                                `Push+ 发送${PUSH_PLUS_USER ? '一对多' : '一对一'
                                }通知消息完成🎉\n`,
                            );
                        } else {
                            console.log(
                                `Push+ 发送${PUSH_PLUS_USER ? '一对多' : '一对一'
                                }通知消息异常 ${data.msg}\n`,
                            );
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
            // v3.126：Server酱 title 上限 32 字符——主代码 titleMax=100 不满足，此处通道层精准截断
            // （安全处理代理对：末尾高代理退一位，避免切坏 emoji）
            if (text.length > 32) {
                let cut = text.slice(0, 32);
                const last = cut.charCodeAt(cut.length - 1);
                if (last >= 0xD800 && last <= 0xDBFF) cut = cut.slice(0, -1);
                text = cut;
            }
            // 微信server酱推送通知一个\n不会换行，需要两个\n才能换行，故做此替换
            desp = desp.replace(/[\n\r]/g, '\n\n');
            const options = {
                url: PUSH_KEY.includes('SCT')
                    ? `https://sctapi.ftqq.com/${PUSH_KEY}.send`
                    : `https://sc.ftqq.com/${PUSH_KEY}.send`,
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
                            // 一分钟内发送相同的内容会触发
                            console.log(`Server 酱发送通知消息异常 ${data.errmsg}\n`);
                        } else {
                            console.log(`Server 酱发送通知消息异常 ${safeErr(data)}`);
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
        const deviceKeys = BARK_PUSH.split('#').filter(key => key.trim());
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
                    reject(err);
                            console.log(`Bark APP 发送通知到 ${maskUrl(pushUrl)} 失败😞\n`, safeErr(err));
                        } else {
                            if (data.code === 200) {
                                console.log(`Bark APP 发送通知到 ${maskUrl(pushUrl)} 成功🎉\n`);
                            } else {
                                console.log(`Bark APP 发送通知到 ${maskUrl(pushUrl)} 异常 ${data.message}\n`);
                            }
                        }
                    } catch (e) {
                        $.logErr(e, resp);
                    } finally {
                        innerResolve();
                    }
                });
            });
        });

        // 等待所有推送完成
        Promise.all(pushPromises).then(resolve);
    });
}

function pushMeNotify(text, desp, params = {}) {
    return new Promise((resolve, reject) => {
        const { PUSHME_KEY, PUSHME_URL } = push_config;

        if (!PUSHME_KEY) {
            return resolve();
        }

        // 分割多个推送KEY
        const pushKeys = PUSHME_KEY.split('#').filter(key => key.trim());
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
                    reject(err);
                            console.log(`PushMe 发送通知到 KEY ${maskKey(trimmedKey)} 失败😞\n`, safeErr(err));
                        } else {
                            if (data === 'success') {
                                console.log(`PushMe 发送通知到 KEY ${maskKey(trimmedKey)} 成功🎉\n`);
                            } else {
                                console.log(`PushMe 发送通知到 KEY ${maskKey(trimmedKey)} 异常: ${data}\n`);
                            }
                        }
                    } catch (e) {
                        $.logErr(e, resp);
                    } finally {
                        innerResolve(data);
                    }
                });
            });
        });

        // 等待所有推送完成
        Promise.all(pushPromises).then(resolve);
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
                        if (data.errcode === 0) {
                            console.log('企业微信发送通知消息成功🎉。\n');
                        } else {
                            console.log(`企业微信发送通知消息异常 ${data.errmsg}\n`);
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

function wxPusherNotify(text, desp) {
    return new Promise((resolve, reject) => {
        const { WX_pusher_appToken, WX_pusher_topicIds } =
            push_config;

        const options = {
            url: `https://wxpusher.zjiecode.com/api/send/message`,
            json: {
                appToken: WX_pusher_appToken,
                content: desp,
                summary: text.substring(0, 90),
                contentType: 3, // 1文字 2HTML 3Markdown
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
                        if (data.code === 1000) {
                            // console.log('WxPusher发送通知消息成功🎉。\n');
                        } else {
                            console.log(`WxPusher发送通知消息异常\n`);
                            // 打印响应摘要（不打印完整对象——异常响应可能回显请求参数含 token）
                            console.log(data && data.msg ? data.msg : JSON.stringify(data).slice(0, 200));
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
                        if (data.code === 200) {
                            console.log('息知发送通知消息成功🎉。\n');
                        } else {
                            console.log(`息知发送通知消息异常 \n`);
                            // 打印响应摘要（不打印完整对象——异常响应可能回显请求参数）
                            console.log(data && data.msg ? data.msg : JSON.stringify(data).slice(0, 200));
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
                                `PushDeer 发送通知消息异常😞 ${safeErr(data)}`,
                            );
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
            // v3.139：TG 消息上限 4096 字符——内容超长截断（字符截断+代理对安全）
            const tgFull = esc(tgDesp ? `${tgText}\n\n${tgDesp}` : tgText);
            const tgCut = tgFull.length > 4000 ? tgFull.slice(0, 4000) : tgFull;
            const tgLast = tgCut.charCodeAt(tgCut.length - 1);
            const tgSafe = (tgLast >= 0xD800 && tgLast <= 0xDBFF) ? tgCut.slice(0, -1) : tgCut;
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
function mdToPlain(s, stripAngle = true) {
    return String(s === undefined || s === null ? '' : s)
        .replace(/\*\*([^*]+)\*\*/g, '$1')            // **粗体** → 粗体
        .replace(/\*([^*]+)\*/g, '$1')                // *斜体* → 斜体
        .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '$1')   // ![alt](url) → alt
        .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)') // [text](url) → text (url)
        .replace(/^#{1,6}\s+/gm, '')                  // # 标题
        .replace(/`([^`]+)`/g, '$1')                  // `代码` → 代码
        .replace(/<([^>]+)>/g, stripAngle ? '$1' : '<$1>'); // <url> autolink → url（TG 保留转义）
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
    if (push_config.HITOKOTO !== 'false') {
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

module.exports = { sendNotify, push_config, maskKey, maskUrl };
