// @ts-nocheck
let value = 9001;
//  ^? let value: number

// $ExpectError
value = "over nine thousand";

// $ExpectType number
9001;
