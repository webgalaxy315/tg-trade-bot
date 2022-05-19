require("dotenv").config()
const isDev = process.env.NODE_ENV==="development"
import * as express from 'express'
import { Filter, ObjectId } from 'mongodb'
import * as fs from 'fs'
import axios from 'axios'
import { setlog } from './helper'
import { bucketUploads, Config, getConfig, getOrCreateUser, Posts, queryFiles, setConfig, Users } from './Model'
/* import jieba, { cut } from 'jieba-js'; */
// const cut = require("jieba-js").cut
// const jieba = require("jieba-js");
const router = express.Router()

const now = () => Math.round(new Date().getTime()/1000)

const apiUrl = isDev ? 'https://api.telegram.org' : 'https://api.telegram.org'
const serverUrl = process.env.SERVERURL || ''
const botAdmin = process.env.BOT_ADMIN || ''
const botKey = (isDev ? process.env.DEV_BOT_KEY : process.env.BOT_KEY) || ''
const botName = (isDev ? process.env.DEV_BOT_NAME : process.env.BOT_NAME) || ''

const PREFIX_POST = "ff"
const PREFIX_ORDER = "fe"

const defaultMessage = `购买和对接联系 @fucktgg，群  @heise123，系统正在完善（部分商品因网盘过期和源头离线 需咨询购买）`
let channelId = 0

router.post("/set-webhook", async (req:express.Request, res:express.Response)=>{
	try {
		const { url } = req.body
		const response = await axios.post(`${apiUrl}/bot${botKey}/setWebhook`, { url: url + "/api/telegram/webhook" })
		res.json(response.data)
	} catch (error) {
		setlog("bot-set-webhook", error)
		res.json(error)
	}
})

router.post("/webhook", (req:express.Request, res:express.Response)=>{
	try {
		// fs.appendFileSync(__dirname + '/../response.json', JSON.stringify(req.body, null, '\t'))
		parseMessage(req.body)
	} catch (error) {
		setlog("bot-webhook", error)
	}
	res.status(200).send('')
})

router.get("/assets/:id",async (req:express.Request, res:express.Response)=>{
	try {
		const { id } = req.params
		const downStream = bucketUploads.openDownloadStream(new ObjectId(id))
		downStream.pipe(res);
	} catch (error) {
		res.status(404).send('not found resource')
	}
})

router.get("/update-database",async (req:express.Request, res:express.Response)=>{
	try {
		const filters = [
			/条\d+美金/,
			/\d+美金/,
			/美金/,
			/\d+美元/,
		]
		let count = 0
		for (let $regex of filters) {
			const rows = await Posts.find({ title:{ $regex } }).toArray()
			for (let i of rows) {
				const title = i.title.replace($regex, '')
				await Posts.updateOne({ _id:i._id }, { $set: { title } })
			}
			count += rows.length
		}
		res.json({ count })
	} catch (error) {
		res.status(404).send('not found resource')
	}
})

export const initTelegram = async () => {
	const id = await getConfig("CHANNEL")
	if (id!=='') channelId = Number(id)
}

const replyBot = async (api:string, json:any) => {
	// let url = `${apiUrl}/bot${botKey}/${api}`
	// let options = { url, method: "POST", headers: {'Content-Type': 'application/json'}, json };
	try {
		const response = await axios.post(`${apiUrl}/bot${botKey}/${api}`, json)
		if (response.data) {
			console.log(response.data)
		}
		return true
	} catch (error) {
		setlog("bot-replyBot", error)
	}
	return false
}

const api = {
	channel: (text:string) => {
		if (channelId!==0) {
			api.send({
				chat_id:channelId,
				text,
				parse_mode:'html',
				disable_web_page_preview:true
			})
		} else {
			console.log('undefined channel')
		}
	},
	none: (chat_id:string|number)=>{
		api.send({
			chat_id,
			text:`由于部分商品失效或自动发货链接失效 下单交易请 @${process.env.TELEGRAMADMIN} 检索发送文字给机器人（机器人只是搜索 登录暗网交易）`,
			parse_mode:'html',
			disable_web_page_preview:true
		})
	},
	remove: (json:any) => replyBot('deleteMessage',json),
	send: (json:any) => replyBot('sendMessage',json),
	sendPhoto: (json:any) => replyBot('sendMessage',json),
	edit: (json:any) => replyBot('editMessageText',json),
	forward: (json:any) => replyBot('forwardMessage',json),
	answer: (callback_query_id:number, text:string) => replyBot('answerCallbackQuery', { callback_query_id, text, show_alert:true }),
}

const parseMessage = async (body:any):Promise<boolean> => {
	try {
		if (body.message!==undefined)  {
			const { message_id, from, chat, forward_from, text } = body.message
			const valid = text!==undefined && forward_from===undefined
			if (valid) {
				const username = from.username || ''
				const fullname = from.first_name + (from.last_name!==undefined ? ' ' + from.last_name : '')
				if (from.is_bot) return false
				if (chat.type==='private') {
					if (text.indexOf('/start')===0) {
						const param = text.slice(7)
						if (param.slice(0,2)===PREFIX_POST) {
							const token = param.slice(2)
							await showPost(token, chat.id, message_id)
						} else if (param.slice(0,2)===PREFIX_ORDER) {
							const token = param.slice(2)
							await showOrder(token, chat.id, message_id)
						} else {
							const user = await getUser(from.id, username, fullname)
							await showProfile(user, chat.id, message_id)
						}
						return true
					}
				}
				await findPosts(text, username, fullname, from.id, chat.id, message_id, 0, 0)
			}
			await api.remove({chat_id:chat.id, message_id})
		} else if (body.channel_post!==undefined)  {
			const { chat, text } = body.channel_post
			const valid = chat.type==='channel' && text!==undefined
			if (valid) {
				if (text==="subscribe from this channel") {
					channelId = chat.id
					await setConfig("CHANNEL", chat.id)
					await api.channel(`Set up subscription channel successfully`);
				}
			}
		} else if (body.my_chat_member!==undefined)  {

		} else if (body.callback_query!==undefined)  {
			const { id, data, from, message } = body.callback_query
			const { message_id, chat } = message
			const matches = data.match(/([a-z1-9]+)\((.*)\)/)
			if (matches &&matches.length===3) {
				
				const username = from.username || ''
				const fullname = from.first_name + (from.last_name!==undefined ? ' ' + from.last_name : '')

				const fn = matches[1]
				const args = matches[2]
				if (fn==='find') {
					const x = args.split(',')
					const fromId = Number(x[0])
					if (from.id===fromId) {
						await findPosts(x[1], username, fullname, fromId, chat.id, message_id, Number(x[2]), Number(x[3]))
					} else {
						api.answer(id, '不能操作别人的搜索结果');
					}
				} else if (fn==='image') {
					await showImage(chat.id, args)
				} else if (fn==='default') {
					await showDefault(chat.id)
				}
			}
		}
		return true
	} catch (error) {
		setlog("bot-parseCommand", error)
		/* await replyMessage(null, replyToken, ERROR_UNKNOWN_ERROR) */
	}
	return false
}



const getUser = async (id:number, username:string, fullname:string):Promise<SchemaUsers> => {
	const user = await Users.findOne({ id })
	if (user===null) {
		const $set = {
			id, 
			username,
			fullname,
			balance: 0,
			updated:now(),
			created:now()
		} as SchemaUsers
		await Users.updateOne( { id }, { $set }, { upsert:true } )
		return $set
	}
	await Users.updateOne( { id }, { $set:{
		id, 
		username,
		fullname,
		updated:now()
	} } )
	return user
}

const findPosts = async (query:string, username:string, fullname:string, from_id:number, chat_id:number, message_id:number, page?:number, count?:number)=>{
	try {
		query = query.replace(/[\s&\/\\#,+()$~%.'":*?<>{}]/g,'');
		const keywords = [ query ] //await jieba.cut(query)
		const where = { $or:[] } as any
		if (keywords.length) {
			for (let i of keywords) {
				where.$or.push({ title: {$regex: new RegExp(i)} })
			}
		}
		if (where.$or.length>5) where.$or = where.$or.slice(0,5)
		// const where = { title: { $regex: query, $options: 'i' } }
		let isUpdate = false
		if ( count===0 ) {
			const res = await Posts.count(where)
			count = Number(res)
		} else {
			isUpdate = true
		}
		const limit = 20
		let total = 0
		if (count) {
			total = Math.ceil(count / limit)
			if ( page >= total ) page = total - 1
			if ( page < 0 ) page = 0
			const rows = await Posts.find(where).sort({ created:-1 }).skip(page * limit).limit(limit).toArray()

			const lists = [ `关键词 <b>[${query}]</b>搜索结果 ${count}中 ${page + 1} / ${total}页` ] as string[]
			const cmds = [] as Array<{ text:string, url?:string, callback_data?:string }>
			for(let i of rows) {
				lists.push(`<a href="https://t.me/${ botName }?start=${ PREFIX_POST + i._id }">🎁${ i.title }</a>`)
			}
			let json = { chat_id, text:lists.join('\r\n'), parse_mode:'html', disable_web_page_preview:true } as any
			if( total==1 ) {
				json.reply_to_message_id = message_id;
			} else {
				json.message_id = message_id;
				if ( page > 0 ) 	cmds.push({ text: "⬅️上翻", callback_data: `find(${from_id},${query},${page - 1},${count})` });
				if ( page < total ) cmds.push({ text: "下翻➡",  callback_data: `find(${from_id},${query},${page + 1},${count})` });
			}
			json.reply_markup = {
				resize_keyboard: true,
				one_time_keyboard: false,
				force_reply: true,
				inline_keyboard:[
					cmds,
					// [{ text: "查看电报账户", url: `https://t.me/${ botName }?start=profile` }]
				]
			}
			if (!isUpdate) {
				api.send(json)
			} else {
				api.edit(json)
			}
			api.channel(`会员 [${ (username ? '@' + username + ' ' : '') + fullname }] 搜索 【${query}】 结果 ${count}`);
			
		} else {
			api.send({
				chat_id, 
				text: `关键词 <b>[${query}]</b>\r\n没有结果`, 
				parse_mode:'html', 
				disable_web_page_preview:true
			})
		}
	} catch (error) {
		setlog('bot-findPosts', error);
	}
}

const showPost = async (token:string, chat_id:number, message_id:number)=>{
	try {
		let row = await Posts.findOne({ _id: new ObjectId(token), status:100 });
		if ( row!==null ) {
			const files = await queryFiles(row.id)
			let lists = [] as string[]
			let re = /(<([^>]+)>)/ig
			lists.push( '🎁' + row.title.replace(re, '') )
			lists.push( row.contents.replace(re, '').replace(/\r\n\r\n/g, '\r\n').replace(/\r\n\r\n/g, '\r\n').replace(/\r\n\r\n/g, '\r\n') )
			// lists.push(`价格: US$ ${row.price}`)
			
			const cmds = [ { text: "购买", callback_data: `default()`} ] as Array<{ text:string, url?:string, callback_data?:string }>
			if (files.length!==0) {
				const i = files[0]
				cmds.push({ text: "查看图片", callback_data: `image(${ i.id })` })
			}

			let json = {
				chat_id,
				text: lists.join('\r\n'),
				parse_mode:'html',
				disable_web_page_preview:true,
				reply_markup:{
					resize_keyboard: true,
					one_time_keyboard: false,
					force_reply: true,
					inline_keyboard: [
						cmds, 
					]
				}
			}
			api.send(json)
		}else{
			let json={
				chat_id,
				text:'💡 对不起，没找到发布详情，已下架❌',
				parse_mode:'html',
				disable_web_page_preview:true
			};
			api.send(json)
		}
	} catch (error) {
		setlog('bot-showPost', error);
	}
}

const showImage = async (chat_id:number, imageId:string)=>{
	try {
		let json={
			chat_id,
			photo: `${serverUrl}/api/telegram/image/${imageId}`
		};
		api.sendPhoto(json)
	} catch (error) {
		setlog('bot-showImage', error);
	}
}

const showDefault = async (chat_id:number)=>{
	try {
		let json = {
			chat_id,
			text: defaultMessage,
			parse_mode:'html',
			disable_web_page_preview:true
		}
		api.send(json)
	} catch (error) {
		setlog('bot-showDefault', error);
	}
}

const showOrder = async (token:string, chat_id:number, message_id:number)=>{
	try {
		/* let row = await Posts.findOne({ _id: new ObjectId(token), status:100 });
		if ( row!==null ) {
			let lists = [] as string[]
			let re = /(<([^>]+)>)/ig
			lists.push( '🎁' + row.title.replace(re, '') )
			lists.push( row.contents.replace(re, '').replace(/\r\n\r\n/g, '\r\n').replace(/\r\n\r\n/g, '\r\n').replace(/\r\n\r\n/g, '\r\n') )
			lists.push(`价格: US$ ${row.price}`)
			
			let inline_keyboard=[];
			inline_keyboard.push([{ text: "购买", callback_data: ['buy', token].join('-')}])
			inline_keyboard.push([{ text: "↩️ 返回个人中心", callback_data: "profile" }])
			let json = {
				chat_id,
				text: lists.join('\r\n'),
				parse_mode:'html',
				disable_web_page_preview:true,
				reply_markup:{
					resize_keyboard: true,
					one_time_keyboard: false,
					force_reply: true,
					inline_keyboard
				}
			}
			api.send(json)
		}else{
			let json={
				chat_id,
				text:'💡 对不起，没找到发布详情，已下架❌',
				parse_mode:'html',
				disable_web_page_preview:true
			};
			api.send(json)
		} */
	} catch (error) {
		setlog('bot-showOrder', error);
	}
}



const showProfile = async (user:SchemaUsers, chat_id:number, message_id:number)=>{
	try {
		let lists = [] as string[]
		lists.push( `您好 <b>${ user.fullname || user.username }</b>` )
		lists.push( `您的账户ID是: <b>#${user.id}</b>` )
		lists.push( `💰余额: ${user.balance}₿` )
		
		let inline_keyboard = [
			/* [
				{"text": "🎁我的商店","callback_data": 'posts'},
				{"text": "✏️发布","callback_data": 'new'},
			], */
			/* [
				{"text": "🛍查看订单","callback_data": 'orders'}
			], */
			[
				// { "text": "📥充值","callback_data": "deposit()" },
				// {"text": "📤提现","callback_data": "withdraw"}
				{ text: "📥充值", callback_data: `default()` },
				{ text: "📤提现", callback_data: `default()` }
				/* { text: "📥充值", url: `https://t.me/${botAdmin}` },
				{ text: "📤提现", url: `https://t.me/${botAdmin}` } */
			],
			[
				{ text: "👩🏻‍🦰联系管理", url: `https://t.me/${botAdmin}` }
			]
		]
		
		/* inline_keyboard.push([
			{"text": "暗网自由城平台开户","callback_data": 'password'},
		]) */
		
		let json={
			chat_id,
			text: lists.join('\r\n'),
			parse_mode: 'html',
			disable_web_page_preview: true,
			reply_markup: {
				resize_keyboard: 	true,
				one_time_keyboard: 	false,
				force_reply: 	true,
				inline_keyboard
			}
		};
		// if(callback_query_id) json.message_id=message_id;
		// TelegramApi[callback_query_id?'edit':'send'](json);
		// setTg({id:vtg.uid,username:vtg.tgname || vtg.tgid},'显示我的');
		// TelegramApi.channel('个人中心 (会员 ['+vtg.tgname+'])');
		api.send(json)
	} catch (error) {
		setlog('bot-showProfile', error);
	}
}


export default router