import { script, opcodes, payments, Psbt, initEccLib } from 'bitcoinjs-lib';
import { witnessStackToScriptWitness } from 'bitcoinjs-lib/src/psbt/psbtutils';
import { Buffer } from 'buffer';
import { LEAF_VERSION_TAPSCRIPT, } from 'bitcoinjs-lib/src/payments/bip341';
import * as ecc from 'tiny-secp256k1';
import { assert } from './BtfdUtils';
import { NetworkFeeEstimator } from './NetworkFeeEstimator';
// Initialize the ECC library
initEccLib(ecc);
const encoder = new TextEncoder();
export class InscriptionUtils {
    static createTextInscription(text, postage = 10000) {
        const contentType = Buffer.from(encoder.encode('text/plain;base64'));
        const content = Buffer.from(text, 'base64');
        return { contentType, content, postage };
    }
    static createCommitTx(network, publicKey, inscription) {
        assert(!!publicKey, 'encodePublic is required');
        assert(!!inscription, 'inscription is required');
        const xOnlyPublicKey = toXOnly(publicKey);
        const code = createInscriptionScript(xOnlyPublicKey, inscription);
        const outputScript = script.compile(code);
        const redeem = {
            output: outputScript,
            redeemVersion: LEAF_VERSION_TAPSCRIPT,
        };
        const scriptTree = {
            output: outputScript,
        };
        const scriptTaproot = payments.p2tr({
            internalPubkey: xOnlyPublicKey,
            scriptTree,
            redeem,
            network,
        });
        console.log('ScriptTaproot:', scriptTaproot.address);
        assert(!!(scriptTaproot === null || scriptTaproot === void 0 ? void 0 : scriptTaproot.hash), 'scriptTaproot.hash was note created');
        return scriptTaproot;
    }
    static commitPsbt(network, commitOutput, commitInput) {
        assert(network, 'network is required');
        assert(commitOutput, 'commitOutput is required');
        assert(commitInput, 'input is required');
        // Create a new Psbt (Partially Signed Bitcoin Transaction)
        const psbt = new Psbt({ network });
        console.log('CommitInput.sendAmount:', commitInput.sendAmountCommit.toString());
        // Add the UTXOs as inputs to the transaction
        psbt.addInput({
            ...commitInput.input,
        });
        psbt.addOutput({
            value: commitInput.sendAmountCommit,
            address: commitOutput.address,
        });
        psbt.addOutput({
            value: commitInput.refundAmount,
            address: commitInput.refundAddress,
        });
        return psbt;
    }
    static finalizeCommitPsbt(psbt) {
        assert(psbt, 'psbt is required');
        psbt.finalizeAllInputs();
        return psbt;
    }
    static createRevealPsbt(network, qpAddress, commitedAmount, sendAmount, commitPayment, // First output of the previous commit transaction
    commitTxHash) {
        assert(network, 'network is required');
        const psbt = new Psbt({ network });
        psbt.addInput({
            hash: commitTxHash,
            index: 0,
            witnessUtxo: {
                script: commitPayment.output,
                value: commitedAmount,
            },
            tapInternalKey: commitPayment.internalPubkey,
            tapLeafScript: [
                {
                    leafVersion: commitPayment.redeemVersion,
                    script: commitPayment.redeem.output,
                    controlBlock: commitPayment.witness[commitPayment.witness.length - 1],
                },
            ],
        });
        psbt.addOutput({
            value: sendAmount,
            address: qpAddress,
        });
        return psbt;
    }
    static finalizeRevealPsbt(psbt, psbtPayment) {
        assert(psbt, 'psbt is required');
        const customFinalizer = (_inputIndex, input) => {
            const witness = [input.tapScriptSig[0].signature]
                .concat(psbtPayment.redeem.output)
                .concat(psbtPayment.witness[psbtPayment.witness.length - 1]);
            return {
                finalScriptWitness: witnessStackToScriptWitness(witness),
            };
        };
        psbt.finalizeInput(0, customFinalizer);
        return psbt;
    }
    static async standardInput(network, address, publicKey, sendAmount, networkFeeCommit, networkFeeReveal, utxoProvider) {
        assert(network, 'network is required');
        assert(address, 'address is required');
        assert(publicKey, 'publicKey is required');
        assert(sendAmount, 'amount is required');
        assert(networkFeeCommit, 'networkFee is required');
        assert(networkFeeReveal, 'networkFee is required');
        const utxos = await utxoProvider.getUtxos(address);
        const networkFees = networkFeeCommit + networkFeeReveal;
        // Find the first UTXO with more than sendAmount + fee
        const utxo = utxos.find(utxo => BigInt(utxo.value) > sendAmount + networkFees);
        assert(!!utxo, 'No UTXO found with enough value to send the inscription');
        const refundAmount = BigInt(utxo.value) - sendAmount - networkFees;
        // Identify the type of bitcoin address
        const addressType = NetworkFeeEstimator.inputType(address, network);
        let input;
        // if (address.startsWith('1') || address.startsWith('m') || address.startsWith('n')) {
        //   addressType = 'p2pkh';
        // } else if (address.startsWith('3') || address.startsWith('2')) {
        //   addressType = 'p2sh';
        // } else if (address.startsWith('bc1q') || address.startsWith('tb1q')) {
        //   addressType = 'p2wpkh';
        // } else if (address.startsWith('bc1p') || address.startsWith('tb1p')) {
        //   addressType = 'p2tr';
        // } else {
        //   throw new Error('Unsupported address type: ' + address);
        // }
        // Create the appropriate input based on the address type
        switch (addressType) {
            case 'p2pkh':
                input = {
                    hash: utxo.txid,
                    index: utxo.vout,
                    nonWitnessUtxo: await utxoProvider.txBlobByHash(utxo.txid), // This should be the full transaction, not just the txid
                };
                break;
            case 'p2sh':
                const p2wpkh = payments.p2wpkh({ pubkey: publicKey, network });
                input = {
                    hash: utxo.txid,
                    index: utxo.vout,
                    redeemScript: payments.p2sh({ redeem: p2wpkh, network }).redeem.output,
                    nonWitnessUtxo: await utxoProvider.txBlobByHash(utxo.txid), // This should be the full transaction, not just the txid
                    witnessUtxo: {
                        script: p2wpkh.output,
                        value: BigInt(utxo.value),
                    }
                };
                break;
            case 'p2wpkh':
                input = {
                    hash: utxo.txid,
                    index: utxo.vout,
                    witnessUtxo: {
                        script: payments.p2wpkh({ pubkey: publicKey, network }).output,
                        value: BigInt(utxo.value),
                    },
                };
                break;
            case 'p2tr':
                input = {
                    hash: utxo.txid,
                    index: utxo.vout,
                    witnessUtxo: {
                        script: payments.p2tr({ internalPubkey: toXOnly(publicKey), network }).output,
                        value: BigInt(utxo.value),
                    },
                    tapInternalKey: toXOnly(publicKey),
                };
                break;
            default:
                throw new Error('Unsupported address type');
        }
        return {
            input,
            sendAmountCommit: sendAmount + networkFeeReveal,
            sendAmountReveal: sendAmount,
            refundAddress: address,
            refundAmount,
            fee: networkFeeCommit,
        };
    }
}
function toXOnly(pubkey) {
    return pubkey.subarray(1, 33);
}
function createInscriptionScript(xOnlyPublicKey, inscription) {
    assert(inscription, `inscription is required`);
    const protocolId = Buffer.from(encoder.encode('ord'));
    return [
        xOnlyPublicKey,
        opcodes.OP_CHECKSIG,
        opcodes.OP_0,
        opcodes.OP_IF,
        protocolId,
        1,
        1, // ISSUE, Buffer.from([1]) is replaced to 05 rather asMinimalOP than 0101 here https://github.com/bitcoinjs/bitcoinjs-lib/blob/master/src/script.js#L53
        // this may not be an issue but it generates a different script address. Unsure if ordinals indexer detect 05 as the content type separator
        inscription.contentType,
        opcodes.OP_0,
        inscription.content,
        opcodes.OP_ENDIF,
    ];
}
//# sourceMappingURL=InscriptionUtils.js.map