// pdfmake's standard-font containers have no types of their own.
declare module 'pdfmake/build/standard-fonts/*' {
  const container: unknown
  export default container
}
