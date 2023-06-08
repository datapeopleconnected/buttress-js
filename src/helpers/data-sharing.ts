
interface DataSharingConfig {
  endpoint: string,
  apiPath: string,
  token: string | null
}

export function createDataSharingConnectionString(remoteApp: DataSharingConfig) {
  let {endpoint, apiPath, token} = remoteApp;

  const secure = (endpoint.match(/https:\/\//ig));
  const portocol = secure ? 'butts' : 'butt';

  if (endpoint) endpoint = endpoint.replace(/(https|http):\/\//ig, '');
  return `${portocol}://${endpoint}/${apiPath}?token=${token || ''}`;
}