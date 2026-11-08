/**
 * The Firefox Translations models Polaris can fetch, generated from the mirror's
 * file listing at the pinned revision (`LOCAL_MODEL_REVISION`): every file with
 * its size and sha256, so a download that is not byte-for-byte what Mozilla
 * published is refused. Only the pairs Translate's languages reach are listed.
 *
 * Regenerate from `https://huggingface.co/api/models/midudev/firefox-translations/revision/<sha>?blobs=true`.
 */

import type { LocalModelFile } from "./local-models";

export const LOCAL_MODEL_REVISION = "6f6acd72c26975a06a8e61b72d1fbacbd184c23f";

export const LOCAL_MODEL_FILES: Readonly<Record<string, readonly LocalModelFile[]>> = {
    "ar-en": [
        {
            role: "lex",
            name: "lex.50.50.aren.s2t.bin",
            size: 4627200,
            sha256: "4b45f14dbea40d368093a13563fc1ca48457ee70c1291c82b206f3baff210081"
        },
        {
            role: "model",
            name: "model.aren.intgemm.alphas.bin",
            size: 31561787,
            sha256: "7b7af0282dc5f4d8805b9a298c2fa828967e3f09ca10f1942ebeea0b2cfc12fa"
        },
        {
            role: "vocab",
            name: "vocab.aren.spm",
            size: 860035,
            sha256: "51b4ee3f828d10015464523d0b4f5a6c086b0b2a9bde716a581001cf6c260366"
        }
    ],
    "bg-en": [
        {
            role: "lex",
            name: "lex.50.50.bgen.s2t.bin",
            size: 4355920,
            sha256: "e661dfdd88aa9ff9606f237a60c910d97c2e710960199589579f628c5d8aa899"
        },
        {
            role: "model",
            name: "model.bgen.intgemm.alphas.bin",
            size: 31561787,
            sha256: "78f7e6e1435cc2d4a29cf597f493187fe29ddb9ce9d3766c287e2e6d37052d01"
        },
        {
            role: "vocab",
            name: "vocab.bgen.spm",
            size: 922482,
            sha256: "4bafad5fcc0e771ed82233d1e99d69dcb96487b430702f7e688615c8a61f3df4"
        }
    ],
    "ca-en": [
        {
            role: "lex",
            name: "lex.50.50.caen.s2t.bin",
            size: 4359552,
            sha256: "74880047539925630601d61aa6c29a0672046236ca6cf33eeaf6f6f6690e914e"
        },
        {
            role: "model",
            name: "model.caen.intgemm.alphas.bin",
            size: 31561787,
            sha256: "b7f9c70823052f60c257eb1c4eff893abea3648aa9d1c23c8774e1e5ef061434"
        },
        {
            role: "vocab",
            name: "vocab.caen.spm",
            size: 810273,
            sha256: "6d22da90905873c2793d0805e34e5c27901b16e7e7a7a427696696f67dfe1f0e"
        }
    ],
    "cs-en": [
        {
            role: "lex",
            name: "lex.50.50.csen.s2t.bin",
            size: 4990588,
            sha256: "eba6bd9575251525f1941640ea0b6527a06e72a46421579eafea04d635ee20a8"
        },
        {
            role: "model",
            name: "model.csen.intgemm.alphas.bin",
            size: 31561787,
            sha256: "c815273b31074492eaab0ccd78d33d7ac16f94088707ab2492abaedcb9ee0b75"
        },
        {
            role: "vocab",
            name: "vocab.csen.spm",
            size: 815154,
            sha256: "ee4b8ce15c8e1237c5f7a2d04741341beb0a5d5c09820f7ec08f13ee2b212755"
        }
    ],
    "da-en": [
        {
            role: "lex",
            name: "lex.50.50.daen.s2t.bin",
            size: 4489412,
            sha256: "e5f50fba646e0d3cedf2957575aa84c3bdca6798ce32ccd63c956fc043d774a3"
        },
        {
            role: "model",
            name: "model.daen.intgemm.alphas.bin",
            size: 17141051,
            sha256: "2c1ace24220c905404bbb1de14bfeda8a391ef8d6c56f3b193a9d3e340d99b12"
        },
        {
            role: "vocab",
            name: "vocab.daen.spm",
            size: 796018,
            sha256: "b9392fcd9c53b802628d33a160f6eb52ca3d25a07ec9e015ab93b6bd5c7e8033"
        }
    ],
    "de-en": [
        {
            role: "lex",
            name: "lex.50.50.deen.s2t.bin",
            size: 4945796,
            sha256: "113b98460468360cca68c042e1cddf49c4e1931cbb975ed04349c9a3bd607010"
        },
        {
            role: "model",
            name: "model.deen.intgemm.alphas.bin",
            size: 31561787,
            sha256: "3e6f7c2c2425d10824797270b382bee718ff34af2cab9308841c82ca46dc6f20"
        },
        {
            role: "vocab",
            name: "vocab.deen.spm",
            size: 810073,
            sha256: "69f730becafa48e3bb2c244eab66456877c08959a02f2bd5519b5a3088b62f9c"
        }
    ],
    "el-en": [
        {
            role: "lex",
            name: "lex.50.50.elen.s2t.bin",
            size: 4295860,
            sha256: "2c969b069b3d230feddd17db2d74eb658a9b33b960d2d40adbca5496c9784e85"
        },
        {
            role: "model",
            name: "model.elen.intgemm.alphas.bin",
            size: 17141051,
            sha256: "0a43c3716156061494d995d0c88113e789f8d919e0c88a15bc1ad360e0482a8c"
        },
        {
            role: "vocab",
            name: "vocab.elen.spm",
            size: 894960,
            sha256: "e1a1298cc2cf3968f3d7cc3b36bc463a4e1bf154272e8fb2f15142b54edc4349"
        }
    ],
    "en-ar": [
        {
            role: "lex",
            name: "lex.50.50.enar.s2t.bin",
            size: 3139692,
            sha256: "2b7194817c5dd9225ca90c0d908cc92e1d6d1f45625781a5feb037ac568d6a61"
        },
        {
            role: "model",
            name: "model.enar.intgemm.alphas.bin",
            size: 31561787,
            sha256: "ae659d7045fc2e5d6ba50583586a5d94ee4358d92c019847e37b57a0e627faa8"
        },
        {
            role: "vocab",
            name: "vocab.enar.spm",
            size: 863591,
            sha256: "8d93c54aa5e2044c416ec680b5ff9af0227bd698521666e8b1a1ea1b041fbae8"
        }
    ],
    "en-bg": [
        {
            role: "lex",
            name: "lex.50.50.enbg.s2t.bin",
            size: 3075948,
            sha256: "93d4ca4412db269cc4164cbfa04c08edd0f65690c8264d6215a0522d4a13ec1a"
        },
        {
            role: "model",
            name: "model.enbg.intgemm.alphas.bin",
            size: 31561787,
            sha256: "e2b30db98ac6706efc893067a74e51f36f015a8f820fe8a4f0f5052fa6a22f30"
        },
        {
            role: "vocab",
            name: "vocab.enbg.spm",
            size: 922482,
            sha256: "4bafad5fcc0e771ed82233d1e99d69dcb96487b430702f7e688615c8a61f3df4"
        }
    ],
    "en-ca": [
        {
            role: "lex",
            name: "lex.50.50.enca.s2t.bin",
            size: 4344092,
            sha256: "8f2151a7fb75454f5167a8df8758ec02ab02c0302893851bad7caa6b729822fb"
        },
        {
            role: "model",
            name: "model.enca.intgemm.alphas.bin",
            size: 31561787,
            sha256: "735881c99ff303e55eb2e92a3b86762523d5dd1a4797b2574b851062051426ee"
        },
        {
            role: "vocab",
            name: "vocab.enca.spm",
            size: 810653,
            sha256: "64ebcb5f6cb5a954ced615e48a44a85e77a644e4910544014b299b8ee0fa1b1f"
        }
    ],
    "en-cs": [
        {
            role: "lex",
            name: "lex.50.50.encs.s2t.bin",
            size: 3572436,
            sha256: "699b9b59fe3acbcddf831380024b2e139f2cbe225dce96d59ade2b159318f58b"
        },
        {
            role: "model",
            name: "model.encs.intgemm.alphas.bin",
            size: 31561787,
            sha256: "1d7855f91c3e2b8ef79fbea62707d46ceb8a1ad01834ef6dd500f32a7006cc2c"
        },
        {
            role: "vocab",
            name: "vocab.encs.spm",
            size: 815154,
            sha256: "ee4b8ce15c8e1237c5f7a2d04741341beb0a5d5c09820f7ec08f13ee2b212755"
        }
    ],
    "en-da": [
        {
            role: "lex",
            name: "lex.50.50.enda.s2t.bin",
            size: 3864788,
            sha256: "d183786cae59a5df06d5b00c58e3ec2a5791d302240a65540fc6a1da2b66eada"
        },
        {
            role: "model",
            name: "model.enda.intgemm.alphas.bin",
            size: 17141051,
            sha256: "0157ed1162dd5a7a0fc6a3cc86014ec21cb47a8febf77164df24d8921270bb29"
        },
        {
            role: "vocab",
            name: "vocab.enda.spm",
            size: 795349,
            sha256: "b06349522bf053e4a6f01efc4d1450e4fe35717a938a82831988c087229c9619"
        }
    ],
    "en-de": [
        {
            role: "lex",
            name: "lex.50.50.ende.s2t.bin",
            size: 4347672,
            sha256: "7ed39f1cffbd68a27ddf05bbfe068de2060f1d7e69f1a20e27ae923551dd7393"
        },
        {
            role: "model",
            name: "model.ende.intgemm.alphas.bin",
            size: 31561787,
            sha256: "8df29d9494d19f47fd5d97c6a73474c6f657e9f81c1a607c431d02befdf3810f"
        },
        {
            role: "vocab",
            name: "vocab.ende.spm",
            size: 810073,
            sha256: "69f730becafa48e3bb2c244eab66456877c08959a02f2bd5519b5a3088b62f9c"
        }
    ],
    "en-el": [
        {
            role: "lex",
            name: "lex.50.50.enel.s2t.bin",
            size: 2856724,
            sha256: "c2acd9241eb8a1e5b13a43efa5723628839d6e3b3dc7b93e2f20990a6ab81e24"
        },
        {
            role: "model",
            name: "model.enel.intgemm.alphas.bin",
            size: 17141051,
            sha256: "724b358d399c6b23444de36d76e9e2630c7024c29d9e617323b820a11631535a"
        },
        {
            role: "vocab",
            name: "vocab.enel.spm",
            size: 896168,
            sha256: "0ffc5569d7f400f03539c5fc3e28ff35f1d0381eba0ec866c44aef0c26f3ce5e"
        }
    ],
    "en-es": [
        {
            role: "lex",
            name: "lex.50.50.enes.s2t.bin",
            size: 4198436,
            sha256: "7d51237c0a07027dcd61643cfbbb0f8c48597d19907ef53d2cae9d6bec2cf25c"
        },
        {
            role: "model",
            name: "model.enes.intgemm.alphas.bin",
            size: 31561787,
            sha256: "3b1c399511c01c84c36fae5c0524df44096288efdc8236e182b5c97d7ad2244c"
        },
        {
            role: "vocab",
            name: "vocab.enes.spm",
            size: 816054,
            sha256: "5ae254fa9b15aa182e70fd2a6186b1333c63a29a48043a9224c6aa4fcac058ad"
        }
    ],
    "en-et": [
        {
            role: "lex",
            name: "lex.50.50.enet.s2t.bin",
            size: 3488368,
            sha256: "259c60582f49449c226a6e5a369481c68322013f367e459e54c595686c05d4d8"
        },
        {
            role: "model",
            name: "model.enet.intgemm.alphas.bin",
            size: 31561787,
            sha256: "36bdc87f8d500861a5d286ebd3ea58df530da87e31b8a233f5e9c46c300c281d"
        },
        {
            role: "vocab",
            name: "vocab.enet.spm",
            size: 817574,
            sha256: "89a3deea4ae7d674fb46a4dae39135dd4dfaac9786f2868d0b5bc5c0aca2ef83"
        }
    ],
    "en-eu": [
        {
            role: "lex",
            name: "lex.50.50.eneu.s2t.bin",
            size: 3149580,
            sha256: "a6a856a89acc6bbf970b6c5e51fe705bee6fe2b8007a3c31ae54ca2c6fd69aad"
        },
        {
            role: "model",
            name: "model.eneu.intgemm.alphas.bin",
            size: 31561787,
            sha256: "f28d03817b718806c9262e3d76960efb8cbd04d0721307c8e23edcae9364150a"
        },
        {
            role: "vocab",
            name: "vocab.eneu.spm",
            size: 820820,
            sha256: "d0cbd7a04e20c3a45bcf29260967db26a97c4787c03a9d867df0465bc104cec2"
        }
    ],
    "en-fi": [
        {
            role: "lex",
            name: "lex.50.50.enfi.s2t.bin",
            size: 3490092,
            sha256: "26e95a87f87e4b0fa9a35524cf9fea691204504453877ba4ac81ccc66af1488c"
        },
        {
            role: "model",
            name: "model.enfi.intgemm.alphas.bin",
            size: 31561787,
            sha256: "88b0caa4cc6980d632801cb2b1950748f1dc43ad2ac83678917ad86c720b5cdd"
        },
        {
            role: "vocab",
            name: "vocab.enfi.spm",
            size: 818770,
            sha256: "6a866911427f2916609ae89c7f2f04a78de3fdd8aa183039ecba986635d4f246"
        }
    ],
    "en-fr": [
        {
            role: "lex",
            name: "lex.50.50.enfr.s2t.bin",
            size: 4372936,
            sha256: "2585ed98d3af0bc949865aedeb390493d591f56870814376e73e4144c41ed059"
        },
        {
            role: "model",
            name: "model.enfr.intgemm.alphas.bin",
            size: 31561787,
            sha256: "6322e296d4fecfe395a8d5723da4ec37ecbe6d7613bb1dfcf4b28e2a47498b68"
        },
        {
            role: "vocab",
            name: "vocab.enfr.spm",
            size: 814404,
            sha256: "783abf3abe075afdf8d85d233994bef2c3a064e935ab1bed946820aff6ac002a"
        }
    ],
    "en-gl": [
        {
            role: "lex",
            name: "lex.50.50.engl.s2t.bin",
            size: 3007680,
            sha256: "28621d3797a945ca0112c872640686586e77957b5421b0ef95886806b09d8874"
        },
        {
            role: "model",
            name: "model.engl.intgemm.alphas.bin",
            size: 31561787,
            sha256: "bec08e5408932c3813ccfb565ab7003d334dd6ca148c9d2bd074e17b8c0be1b1"
        },
        {
            role: "vocab",
            name: "vocab.engl.spm",
            size: 827026,
            sha256: "da044600f961c4c977e747cc9fb8afd4c05829629033d344a575a93807ea1cba"
        }
    ],
    "en-he": [
        {
            role: "lex",
            name: "lex.50.50.enhe.s2t.bin",
            size: 3066048,
            sha256: "8795f4c5e19b4a196c9ed394c275a28a09e5ddbbf47ae16faa4446bf2b8bc7d9"
        },
        {
            role: "model",
            name: "model.enhe.intgemm.alphas.bin",
            size: 17141051,
            sha256: "e37ac6e6f131704c85deb94a657aa20afbb44db2879f44aec9c33a34f4467587"
        },
        {
            role: "vocab",
            name: "vocab.enhe.spm",
            size: 845017,
            sha256: "672b334afa84011200fdaee02c2fc7810910c35ae9ea7619be073c851703ce9e"
        }
    ],
    "en-hi": [
        {
            role: "lex",
            name: "lex.50.50.enhi.s2t.bin",
            size: 3504820,
            sha256: "b473f6fe41cdb7c1dbeeb714fc50314feab77b0af2b2da6f7830ee14492dd847"
        },
        {
            role: "model",
            name: "model.enhi.intgemm.alphas.bin",
            size: 17141051,
            sha256: "18682fa6aa1c1b2f78a6fcbcb354755094d623e65436ef7821720c5213e11a49"
        },
        {
            role: "vocab",
            name: "vocab.enhi.spm",
            size: 925360,
            sha256: "8017cbf812bae400794c424699b89de90db06ac7a4ca67a420013a9f68b270c1"
        }
    ],
    "en-hu": [
        {
            role: "lex",
            name: "lex.50.50.enhu.s2t.bin",
            size: 3419024,
            sha256: "b1c9763567bfa24082fee43a9c4cc05b8ceada949fa52f6686b11f70ce481238"
        },
        {
            role: "model",
            name: "model.enhu.intgemm.alphas.bin",
            size: 31561787,
            sha256: "0c42f56edca74b3f732a74c64553c47d0005b50cf095f43024601985fab5d461"
        },
        {
            role: "vocab",
            name: "vocab.enhu.spm",
            size: 832855,
            sha256: "8c3038afc15c5a3f7bb3c6fc4c4962907632b6f6d0ce7444974504bef19ef57b"
        }
    ],
    "en-id": [
        {
            role: "lex",
            name: "lex.50.50.enid.s2t.bin",
            size: 3515428,
            sha256: "d37f72bcab6e7bc52fd223350f95521b5810bb2486a97275f86077988fced3f4"
        },
        {
            role: "model",
            name: "model.enid.intgemm.alphas.bin",
            size: 17141051,
            sha256: "f81f13eef703a4e0650ffc3138a0f4bab7b6c8bfd173ef1b7bda68d16b8bc7e8"
        },
        {
            role: "vocab",
            name: "vocab.enid.spm",
            size: 773211,
            sha256: "61bc7db24d3b6de638a02a280580a273fe0c942ecbe8a8204b2f81978211db22"
        }
    ],
    "en-it": [
        {
            role: "lex",
            name: "lex.50.50.enit.s2t.bin",
            size: 4133192,
            sha256: "8b21914804625b2777dae7fdb636eb78f02a3eb8b7bceaa50f29ac740961da93"
        },
        {
            role: "model",
            name: "model.enit.intgemm.alphas.bin",
            size: 31561787,
            sha256: "248f47568788ecc351da7e5e07064d4153b4f71e011364ae2c931ffeec4d1cc2"
        },
        {
            role: "vocab",
            name: "vocab.enit.spm",
            size: 812724,
            sha256: "3ef0211d4ae6db21440892f180f2019fe2bfc110a330ffa9d2eca9665e4f2bc5"
        }
    ],
    "en-ja": [
        {
            role: "lex",
            name: "lex.50.50.enja.s2t.bin",
            size: 4128360,
            sha256: "edfb7eb47b98a2689b804ab3614c31b24f1257aa54b1154da3d85e1ae8152d9f"
        },
        {
            role: "model",
            name: "model.enja.intgemm.alphas.bin",
            size: 43849787,
            sha256: "59ae659f9bb63e4f81f474fe3c03d3f4499434b5f9e779fab7c12a45f31fd562"
        },
        {
            role: "srcvocab",
            name: "srcvocab.enja.spm",
            size: 796275,
            sha256: "970c98d174fc01e0339fbabbf45af36a4be3f26f819ec1a5ea1189f71e091889"
        },
        {
            role: "trgvocab",
            name: "trgvocab.enja.spm",
            size: 827144,
            sha256: "3b3d9f8f3a034d98d0a476f1794fa79c01e4e98a967ceb6777a66ba2d03ec1e1"
        }
    ],
    "en-ko": [
        {
            role: "lex",
            name: "lex.50.50.enko.s2t.bin",
            size: 6449612,
            sha256: "96efba97d4bb93ab362e5569bea0f115184d2f68d63b67305ee663c18e32fbeb"
        },
        {
            role: "model",
            name: "model.enko.intgemm.alphas.bin",
            size: 43849787,
            sha256: "ffe5ef2ce3f2e944055e35310bab186f6a70d533a0ee4394adf716a0e383afbb"
        },
        {
            role: "srcvocab",
            name: "srcvocab.enko.spm",
            size: 791280,
            sha256: "8d4e3141868efd410eb86c2b60d41aa6bc6b46e4c4b2c0b85e3792493c69d802"
        },
        {
            role: "trgvocab",
            name: "trgvocab.enko.spm",
            size: 815353,
            sha256: "2ece21b28dd7022d36127d17423a74dabf544787dfc1cf614f7b565f93a4a1d3"
        }
    ],
    "en-lt": [
        {
            role: "lex",
            name: "lex.50.50.enlt.s2t.bin",
            size: 3421640,
            sha256: "5972c834218c7beea241dc8fe77c2e577a8d8b4eb3d3dc286d10ad890c64d374"
        },
        {
            role: "model",
            name: "model.enlt.intgemm.alphas.bin",
            size: 31561787,
            sha256: "d27c676d9d761c2abfffec83956e32b2923f3f745b56acdbd84c49d888cdc94e"
        },
        {
            role: "vocab",
            name: "vocab.enlt.spm",
            size: 806827,
            sha256: "5d38fe70ff4a50368af756b715b69519c9ee064c27cbceeabc90d4e1a10f25a8"
        }
    ],
    "en-lv": [
        {
            role: "lex",
            name: "lex.50.50.enlv.s2t.bin",
            size: 3359096,
            sha256: "d54b9bc278558444c5c25df5ae7339b73eee55cf79705f19fec672b6d55d959c"
        },
        {
            role: "model",
            name: "model.enlv.intgemm.alphas.bin",
            size: 31561787,
            sha256: "715f9f444dffa0b39e71955c28bffd30afa4cc8300a192ec8fabb766cc5ba11d"
        },
        {
            role: "vocab",
            name: "vocab.enlv.spm",
            size: 816287,
            sha256: "63146b49ce46ba1283b6956e38efdd4899d1a409cad9d2b6a06cbd4e32ca0808"
        }
    ],
    "en-nb": [
        {
            role: "lex",
            name: "lex.50.50.ennb.s2t.bin",
            size: 4234572,
            sha256: "0780a1659ef460864ba92da6d58ca6f9056fb8ec8be507c189aeb25ce23e429f"
        },
        {
            role: "model",
            name: "model.ennb.intgemm.alphas.bin",
            size: 17141051,
            sha256: "78429eb7f544361061c9d9ec2f0872adf30b76e4c9ef3dbaab1210a0f2aa19b5"
        },
        {
            role: "vocab",
            name: "vocab.ennb.spm",
            size: 802190,
            sha256: "cad75f2c3eccb9545b571ca32f235e6ffaae6d8a77bfa808cf8068948c421f10"
        }
    ],
    "en-nl": [
        {
            role: "lex",
            name: "lex.50.50.ennl.s2t.bin",
            size: 4030624,
            sha256: "bb4922718f8ca6d746ad090c0a88110a664dc050ee3f311bce33698b4e1679e9"
        },
        {
            role: "model",
            name: "model.ennl.intgemm.alphas.bin",
            size: 31561787,
            sha256: "7e8402da61972dc2fdcf7147c7f1e12f7916a6d9349514ee7a731288357575a9"
        },
        {
            role: "vocab",
            name: "vocab.ennl.spm",
            size: 807708,
            sha256: "c09588ca5662b230ed65bd39a07f58d9f7dd21c3a19e4aeb1bff39bf3b297c56"
        }
    ],
    "en-pl": [
        {
            role: "lex",
            name: "lex.50.50.enpl.s2t.bin",
            size: 3540052,
            sha256: "d7d7b364673f633763c9f8f2e8ee9c7a184e92f4086e8b84abe870a2a8dbe5d5"
        },
        {
            role: "model",
            name: "model.enpl.intgemm.alphas.bin",
            size: 31561787,
            sha256: "b0b59716bcc8f46b8dc6ab5c32a2732acaad42a5a6d9ae9b472526a1bb0d71d4"
        },
        {
            role: "vocab",
            name: "vocab.enpl.spm",
            size: 821612,
            sha256: "2000f182efa8ce5f69bc3f9e574666b5bc2c0af684eedd32f69d15aa9021ea85"
        }
    ],
    "en-pt": [
        {
            role: "lex",
            name: "lex.50.50.enpt.s2t.bin",
            size: 3970340,
            sha256: "ccb4c31c9e1899d77a200e71a86958e6ef6c8649627d0bbf3f873b57d9f236bd"
        },
        {
            role: "model",
            name: "model.enpt.intgemm.alphas.bin",
            size: 31561787,
            sha256: "07892fd2544ee79dcb643615d8f2debb9793fae16842e87c328e27a3dd26a770"
        },
        {
            role: "vocab",
            name: "vocab.enpt.spm",
            size: 816726,
            sha256: "d9f46182823d5bbc84201252b2dfcac28f63e561f0ec827ed858f241864c9def"
        }
    ],
    "en-ro": [
        {
            role: "lex",
            name: "lex.50.50.enro.s2t.bin",
            size: 3739880,
            sha256: "508bce64a8bc906a99043ad2f4855b4662e06f8827c1c6a75ab83181b4f17f81"
        },
        {
            role: "model",
            name: "model.enro.intgemm.alphas.bin",
            size: 17141051,
            sha256: "aa98c415e5beb1c5ee2f7d2508a3bbba949be223d7d9e5e1788ad0ae8598dda5"
        },
        {
            role: "vocab",
            name: "vocab.enro.spm",
            size: 801522,
            sha256: "d89eedf6cbbcb30d7ed4b0b092189196ac2b010ec0c3ede33a6676b17ea1c95e"
        }
    ],
    "en-ru": [
        {
            role: "lex",
            name: "lex.50.50.enru.s2t.bin",
            size: 2774540,
            sha256: "4d91839726b960e70b6d05c53d0cffd16262832b1c0e1ea99d66f412dcc6a239"
        },
        {
            role: "model",
            name: "model.enru.intgemm.alphas.bin",
            size: 31561787,
            sha256: "184cb5cda528eeefc0f75f5d0035d787b71d74af135e3c5608d01ae02ecfb920"
        },
        {
            role: "vocab",
            name: "vocab.enru.spm",
            size: 904455,
            sha256: "56ee63e14e8cb926c394242adc3ed7cc602644c3d33058cff2ce2959d52a6258"
        }
    ],
    "en-sk": [
        {
            role: "lex",
            name: "lex.50.50.ensk.s2t.bin",
            size: 3356348,
            sha256: "f3d1aec4ee5246d6a6ee5dc7ed4c6b18f6071c7baca69bf1344aef675b95515d"
        },
        {
            role: "model",
            name: "model.ensk.intgemm.alphas.bin",
            size: 31561787,
            sha256: "e33af359fd58c8958104b1b74b3ea302800ccba2f125c1629e09d7f9dd9a3804"
        },
        {
            role: "vocab",
            name: "vocab.ensk.spm",
            size: 808888,
            sha256: "cfa6a9e601d74686b117f041eb1ad9de94c34219110b67367d570a9e27026a46"
        }
    ],
    "en-sl": [
        {
            role: "lex",
            name: "lex.50.50.ensl.s2t.bin",
            size: 3428300,
            sha256: "2190798297bc12505f917189defcf451ab5bd2e815bc05df244dc291dc2ae63b"
        },
        {
            role: "model",
            name: "model.ensl.intgemm.alphas.bin",
            size: 31561787,
            sha256: "a34fc5cc2f52733f64e37f8512cf1ddc4723c08a7a1a59d01fc2b6e641fc2280"
        },
        {
            role: "vocab",
            name: "vocab.ensl.spm",
            size: 803212,
            sha256: "7cd295383c46824c05a05db76b543d3595f2516537dd22b77190a45c8919224d"
        }
    ],
    "en-sv": [
        {
            role: "lex",
            name: "lex.50.50.ensv.s2t.bin",
            size: 3948180,
            sha256: "5761c39887a0e0cd3dd38d22cadc31cecd2a43b0514c4bba96b426736e7fd72d"
        },
        {
            role: "model",
            name: "model.ensv.intgemm.alphas.bin",
            size: 17141051,
            sha256: "65ea0db8e658435846f297384face62dbf1804cfc92de8388b0e368e6ecc25a7"
        },
        {
            role: "vocab",
            name: "vocab.ensv.spm",
            size: 793868,
            sha256: "ff7e366ff4228107e58d76ca348e7dea2eb325452363d68e0047e97fb483e40e"
        }
    ],
    "en-th": [
        {
            role: "lex",
            name: "lex.50.50.enth.s2t.bin",
            size: 3016612,
            sha256: "6961ce07f38e6c113a70855706aa7cad4cc828f986d1751c33f14699f885a2e8"
        },
        {
            role: "model",
            name: "model.enth.intgemm.alphas.bin",
            size: 31561787,
            sha256: "80e326097655fca75f841130da3338a849aa245374e1616448bcf37b9523a05a"
        },
        {
            role: "vocab",
            name: "vocab.enth.spm",
            size: 993517,
            sha256: "5deff7093d558768f8c22406449202e27595f023cc383a2b66beed240ed46443"
        }
    ],
    "en-tr": [
        {
            role: "lex",
            name: "lex.50.50.entr.s2t.bin",
            size: 3261300,
            sha256: "3aba0be842bd4c192659c781e6fdce8eb9b2b1fff29a40d22f75da369d59f46f"
        },
        {
            role: "model",
            name: "model.entr.intgemm.alphas.bin",
            size: 17141051,
            sha256: "ea3cd4ee09de190df265c78d84260e277a9a8a3ddff05eb55d72afe7fc0fdbf4"
        },
        {
            role: "vocab",
            name: "vocab.entr.spm",
            size: 798793,
            sha256: "a220363d60391f7ce3df8ec9785424dbc00c24d5786d1a4308cf8ca3ed3385c2"
        }
    ],
    "en-uk": [
        {
            role: "lex",
            name: "lex.50.50.enuk.s2t.bin",
            size: 3054364,
            sha256: "dbfd4f8dc95da9c575164f7fc95ef00a2fb5f7d9f51b656559f99eeebdb57c87"
        },
        {
            role: "model",
            name: "model.enuk.intgemm.alphas.bin",
            size: 31561787,
            sha256: "ed8bb4a811e1c45a259e91052080d25e5c8b4e2df0e59cb1521c04a57855ef97"
        },
        {
            role: "vocab",
            name: "vocab.enuk.spm",
            size: 922077,
            sha256: "4dd6a91feff71e745395dcc0d52f885848ca0d843d5f70628ca51b3be1b70b45"
        }
    ],
    "en-vi": [
        {
            role: "lex",
            name: "lex.50.50.envi.s2t.bin",
            size: 4597684,
            sha256: "18116817fcd3d24dcdfd97cb57e9e60472800dae3b8a007f6f36d61d645f699c"
        },
        {
            role: "model",
            name: "model.envi.intgemm.alphas.bin",
            size: 31561787,
            sha256: "04fa6044593a404c2aa02b3096f203880852df6f8f41e5eb966ed9f2b4366737"
        },
        {
            role: "vocab",
            name: "vocab.envi.spm",
            size: 785200,
            sha256: "76daa9a49e393e50c865c889290e4dc36e9453e5e1ec9df7b9f3bc39ea782537"
        }
    ],
    "en-zh": [
        {
            role: "lex",
            name: "lex.50.50.enzh.s2t.bin",
            size: 4485184,
            sha256: "8575d8daa10e2dbff316dcdf8e1ce475357bcc2c92bdc63b736a2d5add22f681"
        },
        {
            role: "model",
            name: "model.enzh.intgemm.alphas.bin",
            size: 43849787,
            sha256: "4e5accc141373565ddc8fa1565bceaa8d0c3482a82cab8131c719ebcc6c2157c"
        },
        {
            role: "srcvocab",
            name: "srcvocab.enzh.spm",
            size: 806952,
            sha256: "bd9b65504acc6d9726dd281f7defc2adb7c2c22d0688fe2f84697de25197c8c5"
        },
        {
            role: "trgvocab",
            name: "trgvocab.enzh.spm",
            size: 772004,
            sha256: "aded6993c36e440284d11cec3f6b8aef9c0e43188a772d80be342a713adf223d"
        }
    ],
    "en-zh-Hant": [
        {
            role: "lex",
            name: "lex.50.50.enzh_hant.s2t.bin",
            size: 4057188,
            sha256: "d891404d1436a7334df12539fe30a26f9e9f2b80bd42fdb8b5f8849e8a1e942b"
        },
        {
            role: "model",
            name: "model.enzh_hant.intgemm.alphas.bin",
            size: 43849787,
            sha256: "559ab90d723a58c1f1e2ab7cc12137bc667af5ba3e325e3eb30b5cdc930db520"
        },
        {
            role: "srcvocab",
            name: "srcvocab.enzh_hant.spm",
            size: 803694,
            sha256: "2266df70492162a249ab1c0154f929bd6098b246544c666c1a0d5a24dde7d2ea"
        },
        {
            role: "trgvocab",
            name: "trgvocab.enzh_hant.spm",
            size: 751671,
            sha256: "22b91a4436d70b91ab8777c677252ab5fae2bc284d71f977df5206c110e3444c"
        }
    ],
    "es-en": [
        {
            role: "lex",
            name: "lex.50.50.esen.s2t.bin",
            size: 4636248,
            sha256: "e2610211d3b9577d012638fe7e7e74ed7b4b708ce96b9e792e67c282a6492daa"
        },
        {
            role: "model",
            name: "model.esen.intgemm.alphas.bin",
            size: 31561787,
            sha256: "4aed7734152ae0045d1a69ae49c86cfda18f53c61f90e95e1d1de1c7c7c3b033"
        },
        {
            role: "vocab",
            name: "vocab.esen.spm",
            size: 816054,
            sha256: "5ae254fa9b15aa182e70fd2a6186b1333c63a29a48043a9224c6aa4fcac058ad"
        }
    ],
    "et-en": [
        {
            role: "lex",
            name: "lex.50.50.eten.s2t.bin",
            size: 4625968,
            sha256: "ad9750f3b41cb5686e561608271a0dc935fc827bf43226e579a6f48a3f6b5f11"
        },
        {
            role: "model",
            name: "model.eten.intgemm.alphas.bin",
            size: 31561787,
            sha256: "df844b3a6df906b2e0682fb7765694f35b351854db00f964896d9c8c365fbff3"
        },
        {
            role: "vocab",
            name: "vocab.eten.spm",
            size: 817574,
            sha256: "89a3deea4ae7d674fb46a4dae39135dd4dfaac9786f2868d0b5bc5c0aca2ef83"
        }
    ],
    "eu-en": [
        {
            role: "lex",
            name: "lex.50.50.euen.s2t.bin",
            size: 3738856,
            sha256: "4be647536631440bdf68c59d3de5720d8e87a482e0493ff41767488b4df1731d"
        },
        {
            role: "model",
            name: "model.euen.intgemm.alphas.bin",
            size: 31561787,
            sha256: "f0a31e26b381d6340b069da4d505e11d18ac91e42f0189d37ed5fe6aa3685ed4"
        },
        {
            role: "vocab",
            name: "vocab.euen.spm",
            size: 826064,
            sha256: "8f0cdff0c5bca8ed24d91c415f428d8b208f4991087723f38c1c28b59896de89"
        }
    ],
    "fi-en": [
        {
            role: "lex",
            name: "lex.50.50.fien.s2t.bin",
            size: 5195132,
            sha256: "8bad431e07b062ba47f363b76e4656cc743fd608316d8a4830a4315e44ac9abb"
        },
        {
            role: "model",
            name: "model.fien.intgemm.alphas.bin",
            size: 31561787,
            sha256: "e3887341f18bcc7787d9b59eb1229b56eefce18d49b7ebf1e62c55d65a377321"
        },
        {
            role: "vocab",
            name: "vocab.fien.spm",
            size: 818770,
            sha256: "6a866911427f2916609ae89c7f2f04a78de3fdd8aa183039ecba986635d4f246"
        }
    ],
    "fr-en": [
        {
            role: "lex",
            name: "lex.50.50.fren.s2t.bin",
            size: 4824120,
            sha256: "87c6752ea908f5f0347c10ac0cf7d80d9c2f4f20c81c90168f3e8230b56d4440"
        },
        {
            role: "model",
            name: "model.fren.intgemm.alphas.bin",
            size: 31561787,
            sha256: "15f997bc0d13808b0b0fbd0786e684a3c8a52adcd8071844b76123fdacbf2b90"
        },
        {
            role: "vocab",
            name: "vocab.fren.spm",
            size: 814404,
            sha256: "783abf3abe075afdf8d85d233994bef2c3a064e935ab1bed946820aff6ac002a"
        }
    ],
    "gl-en": [
        {
            role: "lex",
            name: "lex.50.50.glen.s2t.bin",
            size: 4367596,
            sha256: "fea6d0e1ea5d5e8e5f7207e4572867fb8f8d8b3f5f983a33067a06b218ab287f"
        },
        {
            role: "model",
            name: "model.glen.intgemm.alphas.bin",
            size: 31561787,
            sha256: "7e8ea0279166c72b0b430327533c643a88f26e80e4a9f9f294244a84213f3e6d"
        },
        {
            role: "vocab",
            name: "vocab.glen.spm",
            size: 827023,
            sha256: "5157bf2e08eeac7b98703bf50a14653eab84607bb707a00db81585f61c814a6c"
        }
    ],
    "he-en": [
        {
            role: "lex",
            name: "lex.50.50.heen.s2t.bin",
            size: 4636028,
            sha256: "427c88732cb93b28d2a947cace79f62aabceb7d6f4438516e85994b14a73b68e"
        },
        {
            role: "model",
            name: "model.heen.intgemm.alphas.bin",
            size: 17141051,
            sha256: "7291cab3ec483b8cf524da96201fe947dca8c550132be21a06badeb946b5c079"
        },
        {
            role: "vocab",
            name: "vocab.heen.spm",
            size: 845177,
            sha256: "45f5d413b9208c5f24340ab0e20a63604a572784d289baa2d788deea946f79a2"
        }
    ],
    "hi-en": [
        {
            role: "lex",
            name: "lex.50.50.hien.s2t.bin",
            size: 4605984,
            sha256: "e789be33dfdb639e98f5cf9eb01aa945ec3c882f68f3c8860389cf846f0112d8"
        },
        {
            role: "model",
            name: "model.hien.intgemm.alphas.bin",
            size: 17141051,
            sha256: "c82fd6ed3794b79fb9dde0718a22324502a408a9eca73497b5d0a4b8024ec6de"
        },
        {
            role: "vocab",
            name: "vocab.hien.spm",
            size: 925436,
            sha256: "9cbc02094ac2ebd75211b3bb6789a9d6fa112ce3c08e897f1645f18b21fbab00"
        }
    ],
    "hu-en": [
        {
            role: "lex",
            name: "lex.50.50.huen.s2t.bin",
            size: 4847184,
            sha256: "9d701f7b9c7472ff0a02154983d67136ef50052b5955fbf32ced0eb8377d235c"
        },
        {
            role: "model",
            name: "model.huen.intgemm.alphas.bin",
            size: 31561787,
            sha256: "477d9ff69eaaf692e9c87b5bad681748f56da2f81b0dd393665c90f5d6f7d55e"
        },
        {
            role: "vocab",
            name: "vocab.huen.spm",
            size: 832895,
            sha256: "77f61965a24b93eef9805d32049791b05fdc351ec4b3dfb938995f947390149c"
        }
    ],
    "id-en": [
        {
            role: "lex",
            name: "lex.50.50.iden.s2t.bin",
            size: 4050348,
            sha256: "7a543087d4e9c1fe2f6b6f735b5e31aeadab80235e734c0388278722042ee3a2"
        },
        {
            role: "model",
            name: "model.iden.intgemm.alphas.bin",
            size: 17141051,
            sha256: "eeed3d8c2c78ec7011b31b2419e1d2dfdf2a7cc0ee0dbb1fcd164c934cb5d328"
        },
        {
            role: "vocab",
            name: "vocab.iden.spm",
            size: 772941,
            sha256: "a2dd1462abd17cccbbf3fefc562131f06b293f8ff6a5efad73ebb0176810d835"
        }
    ],
    "it-en": [
        {
            role: "lex",
            name: "lex.50.50.iten.s2t.bin",
            size: 4713616,
            sha256: "0700d6d70b30490e68ff9deca0b45b80310745b491855bde3a13e1692d0cbce1"
        },
        {
            role: "model",
            name: "model.iten.intgemm.alphas.bin",
            size: 31561787,
            sha256: "21b70978ce2f3b4da7a06b5de86a09abe3acd30b9eee1b2ebb3582b9bad790bf"
        },
        {
            role: "vocab",
            name: "vocab.iten.spm",
            size: 812724,
            sha256: "3ef0211d4ae6db21440892f180f2019fe2bfc110a330ffa9d2eca9665e4f2bc5"
        }
    ],
    "ja-en": [
        {
            role: "lex",
            name: "lex.50.50.jaen.s2t.bin",
            size: 9348172,
            sha256: "525f412f0d210536c2933c78ae395fa0bf2b5ee6cc5dda61ebc2e79410ebaee4"
        },
        {
            role: "model",
            name: "model.jaen.intgemm.alphas.bin",
            size: 43977787,
            sha256: "3a603e20bfe1be86071913f9e23ab5129075bc0a8490151020ac4821e4f17302"
        },
        {
            role: "vocab",
            name: "vocab.jaen.spm",
            size: 1443222,
            sha256: "5cb217758bae05877bb3f0c2f612e4e7c1e4cb03c10db11f4a47098d7ae62919"
        }
    ],
    "ko-en": [
        {
            role: "lex",
            name: "lex.50.50.koen.s2t.bin",
            size: 8617516,
            sha256: "b26291f063ce216a74239275f0485534a38111203e59d42a2a56ba62d6eeb196"
        },
        {
            role: "model",
            name: "model.koen.intgemm.alphas.bin",
            size: 43977787,
            sha256: "7cb30cbc0a86e242084756445268a2346136771c92b884d9b4ebb077f67d5507"
        },
        {
            role: "vocab",
            name: "vocab.koen.spm",
            size: 1410063,
            sha256: "1c72b740ab793cdc3a8f16913dd6b4e806c77421077dd2d85edeb7be38418598"
        }
    ],
    "lt-en": [
        {
            role: "lex",
            name: "lex.50.50.lten.s2t.bin",
            size: 4724124,
            sha256: "f687821f4074063031b7857bd61232b4ef520f3cbac5a80d59993b27bf10a032"
        },
        {
            role: "model",
            name: "model.lten.intgemm.alphas.bin",
            size: 17141051,
            sha256: "0aa4571ede6f68db2f14d2662875b4d2e6323aeccd75e3b4377ab9072a22db70"
        },
        {
            role: "vocab",
            name: "vocab.lten.spm",
            size: 807623,
            sha256: "df3c6b7e9aa74ab4cce9f4ec73a44aac80be05fcd41ae55198a92c07c5ee3109"
        }
    ],
    "lv-en": [
        {
            role: "lex",
            name: "lex.50.50.lven.s2t.bin",
            size: 4214476,
            sha256: "dff852d317f80169899e2e1132277cf922fa7a117b060e09a14dd19c0e1a02b8"
        },
        {
            role: "model",
            name: "model.lven.intgemm.alphas.bin",
            size: 17141051,
            sha256: "7a96dd363ae9b4485aa254ddbff042223a565a20bfe5ba0ba29b94d8ded0406a"
        },
        {
            role: "vocab",
            name: "vocab.lven.spm",
            size: 815278,
            sha256: "585a265757c071f5694d1bb7e65b73f38b1d065a62cda61510fa6c54fb87d2c9"
        }
    ],
    "nb-en": [
        {
            role: "lex",
            name: "lex.50.50.nben.s2t.bin",
            size: 4517876,
            sha256: "cc07976874c905e859918be71d3fe993c9ec8696d986db2418bb1a16ff4ea500"
        },
        {
            role: "model",
            name: "model.nben.intgemm.alphas.bin",
            size: 17141051,
            sha256: "00ab7b969156f6c948be59dad4755e47a24eeb31aa39f02f1de7bce43081cc2a"
        },
        {
            role: "vocab",
            name: "vocab.nben.spm",
            size: 802367,
            sha256: "23eb1743070efac5a447f4f72aafda69b1985af272cece85a2f0bb08e6fcdeef"
        }
    ],
    "nl-en": [
        {
            role: "lex",
            name: "lex.50.50.nlen.s2t.bin",
            size: 4862412,
            sha256: "811ac8f9dcbd12706e2d73a7057a7bbe6b9f0607d15170ffe9439977e8229b41"
        },
        {
            role: "model",
            name: "model.nlen.intgemm.alphas.bin",
            size: 31561787,
            sha256: "ff987741ff15a5d94fff16cbef28f2b0a85a6e9547d982fad60ac09d16d11270"
        },
        {
            role: "vocab",
            name: "vocab.nlen.spm",
            size: 807708,
            sha256: "c09588ca5662b230ed65bd39a07f58d9f7dd21c3a19e4aeb1bff39bf3b297c56"
        }
    ],
    "pl-en": [
        {
            role: "lex",
            name: "lex.50.50.plen.s2t.bin",
            size: 4964208,
            sha256: "b295dfefa7022a62e105276e8c39fdfd67bffe588f4fd78583edd4e04ee0cb3b"
        },
        {
            role: "model",
            name: "model.plen.intgemm.alphas.bin",
            size: 31561787,
            sha256: "06dbab3baa3bbceab746bc6a3bba807878f38536382c03acddf59d3edf3b5d94"
        },
        {
            role: "vocab",
            name: "vocab.plen.spm",
            size: 821612,
            sha256: "2000f182efa8ce5f69bc3f9e574666b5bc2c0af684eedd32f69d15aa9021ea85"
        }
    ],
    "pt-en": [
        {
            role: "lex",
            name: "lex.50.50.pten.s2t.bin",
            size: 4634492,
            sha256: "2685d8b6530be92a4db4cc61f15a097eb114552be15cb6c1699e9d2d99d24470"
        },
        {
            role: "model",
            name: "model.pten.intgemm.alphas.bin",
            size: 31561787,
            sha256: "7b854f1ec5a485dd33efd7c1bc01dd7d5a57f566957c5e47722af333f0ce9157"
        },
        {
            role: "vocab",
            name: "vocab.pten.spm",
            size: 816726,
            sha256: "d9f46182823d5bbc84201252b2dfcac28f63e561f0ec827ed858f241864c9def"
        }
    ],
    "ro-en": [
        {
            role: "lex",
            name: "lex.50.50.roen.s2t.bin",
            size: 4691708,
            sha256: "d242745eadff6f345784fccf1d58046061501b28c8190ba5912a9da5f056cd2f"
        },
        {
            role: "model",
            name: "model.roen.intgemm.alphas.bin",
            size: 17141051,
            sha256: "e7542557fc6dbafacddae7b48e67fcdb07bd67b3fb55a76139edf366eca5dbdb"
        },
        {
            role: "vocab",
            name: "vocab.roen.spm",
            size: 800832,
            sha256: "2a690fbcd1b79bc9b99c43d582252720e0900245c82ecc813c8eb05cf063fd0c"
        }
    ],
    "ru-en": [
        {
            role: "lex",
            name: "lex.50.50.ruen.s2t.bin",
            size: 4397908,
            sha256: "c944e753f298bbdf6506388de7257fb48cbd12c83e2807e2c284fc323771895b"
        },
        {
            role: "model",
            name: "model.ruen.intgemm.alphas.bin",
            size: 31561787,
            sha256: "aa0efa194b3dbd2da129ba0b8db8ef139126cb0914e57072f62061294746f1e2"
        },
        {
            role: "vocab",
            name: "vocab.ruen.spm",
            size: 952371,
            sha256: "de8af5f87e231ee4016cec4bb482e6b584cb1ca34dcb624fc7b8398f25bb35df"
        }
    ],
    "sk-en": [
        {
            role: "lex",
            name: "lex.50.50.sken.s2t.bin",
            size: 4913324,
            sha256: "18577a7ded6b9957c948f2a384683f7ce09def42336c8141eee7ba86b79e2c8e"
        },
        {
            role: "model",
            name: "model.sken.intgemm.alphas.bin",
            size: 17141051,
            sha256: "1686f94838ace314719e945606a09a66dafd40847dd3fd352ad3f7a969aac62f"
        },
        {
            role: "vocab",
            name: "vocab.sken.spm",
            size: 808082,
            sha256: "7d25655bd15f34d77db5d2cb96a51c7943c5528f37f83b677a09bb0ea4e4f59b"
        }
    ],
    "sl-en": [
        {
            role: "lex",
            name: "lex.50.50.slen.s2t.bin",
            size: 4320484,
            sha256: "f456a49e437ccb4a547e4b51480e29c8b83f11e26a3713af35b078cd4dd255cc"
        },
        {
            role: "model",
            name: "model.slen.intgemm.alphas.bin",
            size: 31561787,
            sha256: "9d15df58b60048366de4f7b6e727157ffdaea3a0fd1c1759ce232b057e2f991c"
        },
        {
            role: "vocab",
            name: "vocab.slen.spm",
            size: 803078,
            sha256: "54ed331d3435e2bdc5b02462180197b77631f466fc0e61897b5469449857dd2b"
        }
    ],
    "sv-en": [
        {
            role: "lex",
            name: "lex.50.50.sven.s2t.bin",
            size: 4645680,
            sha256: "1c4640765e806d905cdc4f51158f6f869c78709b9e8a43070877965fa13c160e"
        },
        {
            role: "model",
            name: "model.sven.intgemm.alphas.bin",
            size: 17141051,
            sha256: "92d79e2725718b84aed486473bdfcbe6bba3e7094922d4bead8a121cfa346372"
        },
        {
            role: "vocab",
            name: "vocab.sven.spm",
            size: 793049,
            sha256: "93427195fac4125722ed778707478ef78cb77b3fdf1ed5b93bee9fd36e30a8ec"
        }
    ],
    "th-en": [
        {
            role: "lex",
            name: "lex.50.50.then.s2t.bin",
            size: 4487056,
            sha256: "3a7661a7f5c811c83f05f53008083b042fea0334fc6044ca1fda4982a8d48453"
        },
        {
            role: "model",
            name: "model.then.intgemm.alphas.bin",
            size: 31561787,
            sha256: "f70a501324743668b031bee19cd001a66839e8e5dfc0b4a1c44d5ea99d4e8d66"
        },
        {
            role: "vocab",
            name: "vocab.then.spm",
            size: 995429,
            sha256: "b625d3dcdfa2b4bbec496c9a0a30d169c917464ac5ea75506c0699972fea95f0"
        }
    ],
    "tr-en": [
        {
            role: "lex",
            name: "lex.50.50.tren.s2t.bin",
            size: 4662492,
            sha256: "d3374ab5267a73ee1aa1d926a298bd349426835f40856991ee959bc5cd4f9fce"
        },
        {
            role: "model",
            name: "model.tren.intgemm.alphas.bin",
            size: 17140836,
            sha256: "bd18594ac5a7f1d9997e7ea5bd80272082219cf8b1ce604766e4f207eb86abbf"
        },
        {
            role: "vocab",
            name: "vocab.tren.spm",
            size: 811353,
            sha256: "ed328e589a3ccd70fd3ce7773fc3c01d8b7b18c687464cacf17fd40a8c0daadd"
        }
    ],
    "uk-en": [
        {
            role: "lex",
            name: "lex.50.50.uken.s2t.bin",
            size: 3914120,
            sha256: "32b5e0df493671a223cb5cb32430181cbb7fe6b5562c91dbc3d35410d37e5ff6"
        },
        {
            role: "model",
            name: "model.uken.intgemm.alphas.bin",
            size: 17141051,
            sha256: "2e7b8bc9d2569d8b4ae244e964cdc343a0aa3735cc83ecb664be84a37cb45f48"
        },
        {
            role: "vocab",
            name: "vocab.uken.spm",
            size: 886410,
            sha256: "8b51480dfc4ca2d7a08d2bfdaa9e57353ca97e6cf3d5f9aba4c0179d3665bfc0"
        }
    ],
    "vi-en": [
        {
            role: "lex",
            name: "lex.50.50.vien.s2t.bin",
            size: 3910184,
            sha256: "3a071ed3d982f6eb6ee116b84067bf70041e4229e43ea65ecb6d7c2796e8851b"
        },
        {
            role: "model",
            name: "model.vien.intgemm.alphas.bin",
            size: 17141051,
            sha256: "de4bf2b9ffb4d910e32720ec3a43655fb6f4062ce5219332f824fc1bdca7a5f4"
        },
        {
            role: "vocab",
            name: "vocab.vien.spm",
            size: 757250,
            sha256: "cb152765d1e71ea3cf96fdb339c764b7201be7b9ab32e20cfebcf16a20fc0939"
        }
    ],
    "zh-Hant-en": [
        {
            role: "lex",
            name: "lex.50.50.zh_hanten.s2t.bin",
            size: 6385944,
            sha256: "aa7daf6cfc85c0cd2c10e2944d66f6da55497c9c6408789f3adfded4074c2fb1"
        },
        {
            role: "model",
            name: "model.zh_hanten.intgemm.alphas.bin",
            size: 43849787,
            sha256: "0aee91790894458f5d367551f6edcd4c9cb97852c34f221bcbf9f4701ebcf0cd"
        },
        {
            role: "srcvocab",
            name: "srcvocab.zh_hanten.spm",
            size: 769669,
            sha256: "5cc6a76611dbf86219f109141533606b15ecb34eee83673bb86b2c16b14734db"
        },
        {
            role: "trgvocab",
            name: "trgvocab.zh_hanten.spm",
            size: 812572,
            sha256: "7bf002db37c10d3b114cc5588d7fdcb16c57d0fd1e2c34354c22cc9f0b6c3c29"
        }
    ],
    "zh-en": [
        {
            role: "lex",
            name: "lex.50.50.zhen.s2t.bin",
            size: 9219192,
            sha256: "8524dd4c93ffd7f0ae7be32f77a7c14fea7cdbbebe34ea6ad0ec368d5ddd8b13"
        },
        {
            role: "model",
            name: "model.zhen.intgemm.alphas.bin",
            size: 43977787,
            sha256: "5cd149601802fc8a18124a1c1306144dbbedc058630c4ddb2d53aa76fa9c7c06"
        },
        {
            role: "vocab",
            name: "vocab.zhen.spm",
            size: 1359697,
            sha256: "dff594318ab7d8b7b60b844ab98ebe6b932ae8045fab15235404c787715965b3"
        }
    ]
};
