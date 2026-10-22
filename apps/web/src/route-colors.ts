const colors = ['#285b4a', '#276b9b', '#b4512a'];
export const routeColor = (index: number) => colors[index % colors.length]!;
