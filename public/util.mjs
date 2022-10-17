import {zbdecode} from './encoding.mjs';

const alignN = n => index => {
  const r = index % n;
  return r === 0 ? index : (index + n - r);
};
const align4 = alignN(4);

const parseUpdateObject = uint8Array => zbdecode(uint8Array);

function makeid(length) {
  var result           = '';
  var characters       = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  var charactersLength = characters.length;
  for ( var i = 0; i < length; i++ ) {
    result += characters.charAt(Math.floor(Math.random() * charactersLength));
 }
 return result;
}
const makeId = () => makeid(5);

export {
  alignN,
  align4,
  parseUpdateObject,
  makeId,
};