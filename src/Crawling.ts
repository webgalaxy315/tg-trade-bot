require("dotenv").config()
const isDev = process.env.NODE_ENV==="development"
import * as express from 'express'
// import axios from 'axios'
import * as fs from 'fs'
import * as path from 'path'
import { setlog } from './helper'
import { addFile, getConfig, Posts, setConfig } from './Model'
const tor = require('tor-request');
const cheerio = require('cheerio');
const sizeOf = require('image-size');
const sharp = require('sharp');
// const crypto = require('crypto');

const router = express.Router()
const now = () => Math.round((new Date().getTime()) / 1000)

router.post("/start", async (req:express.Request, res:express.Response)=>{
	// const { pid, count } = req.body
	// pid : 10001 /// data 
	const pid = 10001
	const count = 342
	crawlIndex(pid, count).then(status=>{
		status && crawlPosts()
	})
	res.json({started:true})
})

const host = 'xxxxxxxxxs6qbnahsbvxbghsnqh4rj6whbyblqtnmetf7vell2fmxmad.onion';
const headers = {
	'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; rv:91.0) Gecko/20100101 Firefox/91.0',
	'Cookie': 'random=1064; PHPSESSID=068sm9vfgtijtsqn7nagl256ol; userid=727415'
};

const fetchPost = (url:string) => {
	return new Promise(resolve=>{
		tor.request({url,encoding:null,headers}, (err:any, res:any, body:any)=>{
			if(err) {
				console.log(err);
				return resolve(null);
			}
			resolve(body);
		})
	})
}

const crawlIndex = async (pid:number, count:number):Promise<boolean>=>{
	try {
		// const lastIndex = Number(await getConfig("CRAWL_LAST") || 0)
		let start = 1;
		for (let i = start; i <= count; i++) {
			//ea.php?ea=10009&pagea=45#pagea
			let url = `http://${host}/ea.php?ea=${pid}${i==1 ? '' : '&pagea=' + i + '#pagea'}`
			for (let k = 0; k < 5; k++) {
				let time = +new Date();
				let res=await fetchPost(url);
				if (res) {
					const $ = cheerio.load(res);
					let inserts = [] as SchemaPosts[];
					let lastId = 0
					$('div.length_500').each((i:any,v:any)=>{
						for(let m of v.children) {
							if(m.tagName=='a') {
								let url=m.attribs.href;
								if (url && url.indexOf('viewtopic.php?tid=')===0) {
									let id = Number(url.slice(18));
									let title=m.firstChild.data;
									inserts.push({
										// id,pid:row.id,title,
										id,
										pid,
										uid: 		0,
										username: 	'',
										title,
										contents: 	'',
										result: 	'',
										price:		0,
										sales:		0,
										status:		0,
										updated:	0,
										created:	0,
									})
									if (lastId < id) lastId = id
								}
								break;
							}
						}
					});
					try {
						await Posts.insertMany(inserts)	
					} catch (error) {
						console.log("#" + i, error)
					}
					
					await setConfig("CRAWL_LAST", lastId)
					console.log(`#${i} success ${+new Date() - time}ms`);
					break;
				} else {
					console.log(`#${i} failed ${k+1}`);
					await new Promise(resolve=>setTimeout(resolve,1000));
				}
			}
		}
		setlog("crawlIndex", "completed")
		return true
	} catch (error) {
		setlog('crawlIndex', error)		
	}
	return false
}

const crawlPosts = async () => {
	try {
		const rows = await Posts.find({ status:0 }).toArray()
		for (let row of rows) {
			let time=+new Date();
			let res
			for (let k = 0; k < 10; k++) {
				res=await fetchPost(`http://${host}/viewtopic.php?tid=${row.id}`);
				if(res) break;
				console.log('craw-xx',`page ${row.id} retry ${k+1}`);
			}
			if(!res) {
				console.log('craw-xx',`page ${row.id} crawl error`);
				return;
			}
			const $=cheerio.load(res);
			let vtr=$('table.v_table_1 tr');
			let tr=vtr[2];
			if(tr) {
				let price = Number(tr.childNodes[3].childNodes[0].firstChild.data);
				let created = Math.round(new Date(tr.childNodes[5].firstChild.data+':00').getTime() / 1000);
				tr = vtr[4];
				let username = tr.childNodes[1].firstChild.data;
				let lastonline = tr.childNodes[5].firstChild.data;
				if (lastonline=='1970-01-01 08:00') {
					lastonline = null;
				}else{
					lastonline += ':00';
				}
				tr=vtr[6];
				let sales = Number(tr.childNodes[3].firstChild.data);
				let t = $('t').text();
				let r = $('r').text();
				let contents = (t || r);
				/* let imgs = 0; */
				let is = $('img.attach_image');
				let c = is.length>2?2:is.length;
				if (is.length) {
					for(let i = 0; i < c; i++) {
						let v = is[i];
						let name = v.attribs.alt;
						let src = v.attribs.src;
						let buf = null as any;
						let id = row.id*100
						for (let k = 0; k < 10; k++) {
							buf = await fetchPost(src);
							if (!buf) {
								console.log('craw-xx', `page ${row.id} image retry ${k+1}`);
							} else break;
						}
						if (buf) {
							try {
								let filepath = path.normalize(__dirname + '/../tmp');
								let filename = filepath + '/' + id;
								if (fs.existsSync(filename)) fs.unlinkSync(filename);
								fs.writeFileSync(filename, buf);
								let dims = sizeOf(filename);
								let w=dims.width,h=dims.height;
								let rx=w/800;
								let ry=h/600;
								if(rx>1 || ry>1) {
									if(rx>ry) {
										w=800; h=Math.round(h/rx);
									}else{
										w=Math.round(w/ry); h=600;
									}
								}
								let tmpfile = filename+'.webp';
								if (fs.existsSync(tmpfile)) fs.unlinkSync(tmpfile);
								await sharp(filename).resize(w,h).toFile(tmpfile);
								fs.unlinkSync(filename);
								if (fs.existsSync(tmpfile)) {
									await addFile(name, id, fs.readFileSync(tmpfile))
									fs.unlinkSync(tmpfile);
								}
							} catch (error) {
								console.log(error);
							}
						}
					}
				}
				Posts.updateOne({
					id:row.id
				}, {
					$set: {
						contents,
						price,
						username,
						sales,
						status:100,
						updated: now(),
						created
					}
				})
				console.log('#' + row.id+' -  '+(+new Date()-time));
			}else{
				console.log(row.id+' - it seems blank'+(+new Date()-time));
			}
		}
	} catch (error) {
		setlog("crawlPosts", error)
	}
}

export default router