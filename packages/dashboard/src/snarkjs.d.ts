declare module 'snarkjs' {
  export const groth16: { verify(vk: object, publicSignals: string[], proof: object): Promise<boolean> };
}
