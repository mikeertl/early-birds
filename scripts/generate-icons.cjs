// Render the source SVG with Chrome. Run ./go.sh 8001 first, then:
// TEST_URL=http://127.0.0.1:8001/ node scripts/generate-icons.cjs (Node 22+).
const fs = require('node:fs/promises');
const path = require('node:path');
const { launchBrowser } = require('../tests/browser-helper.cjs');
async function main() {
  const browser = await launchBrowser({url:process.env.TEST_URL || 'http://127.0.0.1:8001/'});
  try {
    const page=await browser.page();
    for(const [size,file,inset=0] of [[32,'favicon.png'],[180,'apple-touch-icon.png'],[192,'icon-192.png'],[512,'icon-512.png'],[512,'icon-maskable-512.png',0.1]]) {
      const data=await page.evaluate(`(async()=>{
        const img=new Image();img.src='assets/early-birds.svg';await img.decode();
        const canvas=document.createElement('canvas');canvas.width=${size};canvas.height=${size};
        const ctx=canvas.getContext('2d');ctx.fillStyle='#f4f1ea';ctx.fillRect(0,0,${size},${size});ctx.drawImage(img,${size*inset},${size*inset},${size*(1-2*inset)},${size*(1-2*inset)});
        return canvas.toDataURL('image/png').split(',')[1];
      })()`);
      const png=Buffer.from(data,'base64');
      await fs.writeFile(path.join(__dirname,'../assets',file),png);
      if(size===32) {
        const header=Buffer.alloc(22);header.writeUInt16LE(1,2);header.writeUInt16LE(1,4);
        header[6]=32;header[7]=32;header.writeUInt16LE(1,10);header.writeUInt16LE(32,12);
        header.writeUInt32LE(png.length,14);header.writeUInt32LE(22,18);
        await fs.writeFile(path.join(__dirname,'../assets/favicon.ico'),Buffer.concat([header,png]));
      }
    }
    console.log('Generated favicon, Apple touch icon and 192/512px app icons from the SVG.');
  } finally {await browser.close();}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
