// The little of pdfmake 0.3's browser build that toPdf.ts uses, typed here: the community types
// pull a newer @types/node into the web app, which splits the test runner in two.

declare module 'pdfmake/build/pdfmake' {
  interface PdfMake {
    addFontContainer(container: unknown): void
    addVirtualFileSystem(vfs: Record<string, string>): void
    addFonts(
      fonts: Record<string, Record<'normal' | 'bold' | 'italics' | 'bolditalics', string>>,
    ): void
    setUrlAccessPolicy(policy: (url: string) => boolean): void
    createPdf(definition: object): { getBlob(): Promise<Blob> }
  }
  const pdfMake: PdfMake
  export default pdfMake
}

// pdfmake's standard-font containers.
declare module 'pdfmake/build/standard-fonts/*' {
  const container: unknown
  export default container
}
