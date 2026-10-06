const AWS = require('aws-sdk');
const dynamo = new AWS.DynamoDB.DocumentClient();
const sqs = new AWS.SQS();

const TABLE_NAME = process.env.TABLE_NAME;
const SQS_QUEUE_URL = process.env.SQS_QUEUE_URL;

exports.handler = async (event) => {
  try {
    const payload = event.body ? JSON.parse(event.body) : {};
    const { eventId, quantity, customerName, customerEmail } = payload;

    if (!eventId || !quantity || !customerName || !customerEmail) {
      return {
        statusCode: 400,
        body: JSON.stringify({ message: 'Dados incompletos para o pedido.' })
      };
    }

    const order = {
      id: `order-${Date.now()}`,
      eventId,
      quantity: Number(quantity),
      customerName,
      customerEmail,
      status: 'pending_payment',
      createdAt: new Date().toISOString()
    };

    await dynamo.put({
      TableName: TABLE_NAME,
      Item: order
    }).promise();

    await sqs.sendMessage({
      QueueUrl: SQS_QUEUE_URL,
      MessageBody: JSON.stringify(order)
    }).promise();

    return {
      statusCode: 201,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: 'Pedido recebido com sucesso!',
        order
      })
    };
  } catch (error) {
    return {
      statusCode: 500,
      body: JSON.stringify({ message: 'Erro interno do servidor.', error: error.message })
    };
  }
};
