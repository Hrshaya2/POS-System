// Throwaway verification harness: runs the real geometry + template code from
// barcode.js (DOM stubbed) and prints the generated print CSS / dimensions.
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>');
global.window = dom.window;
global.document = dom.window.document;
global.XMLSerializer = dom.window.XMLSerializer;

const mod = await import('./src/utils/barcode.js');
const {
  DEFAULT_LABEL_WIDTH_MM: DW, DEFAULT_LABEL_HEIGHT_MM: DH,
  LABEL_SIZE_VERSION: VER, printBarcodeLabel, printBarcodeLabelsBatch
} = mod;

console.log('1) defaults + version');
console.log(`   DEFAULT = ${DW}mm x ${DH}mm   LABEL_SIZE_VERSION = ${VER}`);

let lastHtml = null;
const fakeWin = {
  document: { readyState: 'complete', write: (h) => { lastHtml = h; }, close() {}, },
  focus() {}, print() {}, addEventListener() {},
  requestAnimationFrame: (fn) => fn(), setTimeout: (fn) => fn()
};
global.window.open = () => fakeWin;

console.log('\n2) single label - default size (no size args)');
printBarcodeLabel({ code: 'LM-000133', name: 'iPhone 15 Tempered Glass', price: 4500 });
console.log('   @page        :', lastHtml.match(/@page \{[^}]+\}/)?.[0].trim());
console.log('   .label width :', lastHtml.match(/\.label \{[^}]*?width: [^;]+;/)?.[0].trim());
console.log('   .label height:', lastHtml.match(/height: calc\([^)]+\)/)?.[0]);
console.log('   has page-break-after:', /page-break-after/.test(lastHtml));
console.log('   svg          :', lastHtml.match(/<svg[^>]*width="[^"]+"[^>]*height="[^"]+"/)?.[0]);
console.log('   label count  :', (lastHtml.match(/class="label"/g) || []).length);
console.log('   has print btn:', /class="no-print"/.test(lastHtml));

console.log('\n3) batch - 3 labels x 2 copies');
printBarcodeLabelsBatch({
  items: [
    { code: 'LM-000133', name: 'Charger 20W', price: 4500 },
    { code: '8901234567890', name: 'Screen Guard', price: 500 },
    { code: 'LM-000200', name: 'USB-C Cable', price: 1200 }
  ],
  copiesPerItem: 2
});
console.log('   @page        :', lastHtml.match(/@page \{[^}]+\}/)?.[0].trim());
console.log('   label count  :', (lastHtml.match(/class="label"/g) || []).length, '(expected 6)');
console.log('   svg count    :', (lastHtml.match(/<svg/g) || []).length, '(expected 6)');
console.log('   last-child reset:', /\.label:last-child \{[^}]+\}/.test(lastHtml));
console.log('   font sizes   :', [...lastHtml.matchAll(/font-size: ([\d.]+)mm/g)].map((x) => x[1]).join(', '));

console.log('\n4) empty input must print nothing');
lastHtml = null;
printBarcodeLabelsBatch({ items: [] });
console.log('   window opened:', lastHtml !== null, '(expected false)');

console.log('\n5) custom size still respected (configurable feature kept)');
printBarcodeLabel({ code: 'LM-000133', name: 'X', price: null, widthMm: 50, heightMm: 30 });
console.log('   @page:', lastHtml.match(/@page \{[^}]+\}/)?.[0].trim());
console.log('   height:', lastHtml.match(/height: calc\([^)]+\)/)?.[0]);

console.log('\n6) internal SKU format untouched');
console.log('   isInternalSku(LM-000133):', mod.isInternalSku('LM-000133'));
console.log('   generateInternalSku([]):', mod.generateInternalSku([]));