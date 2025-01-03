import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { CreateCustomerDto } from './dto/createCustomer.dto';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from 'src/database/entities/user.entity';
import { Memberships } from 'src/database/entities/membership.entity';
import { Payment } from 'src/database/entities/payment.entity';
import { MembershipStatus } from 'src/enum/membership_status.enum';
import { UsersCustomRepository } from '../users/users.repository';
import { PaymentsCustomRepository } from './payments.repository';
import { EmailService } from '../email/email.service';
import { Role } from 'src/enum/roles.enum';
const stripe = require('stripe')(process.env.SECRET_STRIPE);

@Injectable()
export class PaymentsService {
  constructor(
    private readonly usersCustomRepository: UsersCustomRepository,
    @InjectRepository(User) private readonly usersRepository: Repository<User>,
    @InjectRepository(Memberships)
    private readonly membershipsCustomRepository: Repository<Memberships>,
    @InjectRepository(Payment)
    private readonly paymentsRepository: Repository<Payment>,
    private readonly paymentsCustomRepository: PaymentsCustomRepository,
    private readonly emailService:EmailService
  ) {}

  async addMemberships() {
    return await this.paymentsCustomRepository.initializePayments();
  }

  async createCustomer(createCustomerDto: CreateCustomerDto) {
    const { userEmail, userName, stripePriceId } = createCustomerDto;

    try {
      const membership = await this.membershipsCustomRepository.findOne({
        where: { stripePriceId: stripePriceId }, // Buscar directamente por el stripePriceId
      });

      if (!membership) {
        throw new Error(
          `No se encontró una membresía con el stripePriceId: ${stripePriceId}`,
        );
      }

      // 2. Crear el cliente en Stripe
      const customer = await stripe.customers.create({
        email: userEmail,
        name: userName,
      });

      // 3. Crear una sesión de pago en Stripe
      const session = await stripe.checkout.sessions.create({
        line_items: [{ price: stripePriceId, quantity: 1 }],
        mode: 'subscription',
        payment_method_types: ['card'],
        customer: customer.id,
        success_url:
          process.env.DOMAIN_STRIPE +
          '/payment/success?session_id={CHECKOUT_SESSION_ID}',
        cancel_url: process.env.DOMAIN_STRIPE + '/cancel',
        metadata: {
          stripePriceId: stripePriceId,
          userEmail: userEmail,
        },
      });

      console.log('Stripe Session ID:', session.id);

      return {
        sessionId: session.id,
        sessionUrl: session.url,
        membershipName: membership.name,
        membershipPrice: membership.price,
        duration: membership.duration,
      };
    } catch (error) {
      console.error('Error creando el cliente o la sesión de pago:', error);
      throw new Error(`Error procesando la solicitud: ${error.message}`);
    }
  }

  async handlePaymentSuccess(sessionId: string): Promise<any> {
    if (!sessionId) {
      throw new HttpException(
        'sessionId no proporcionado',
        HttpStatus.BAD_REQUEST,
      );
    }

    try {
      const session = await stripe.checkout.sessions.retrieve(sessionId);

      if (!session) {
        throw new HttpException(
          'Sesión no encontrada en Stripe',
          HttpStatus.NOT_FOUND,
        );
      }

      if (session.payment_status !== 'paid') {
        throw new HttpException(
          'El pago no se completó',
          HttpStatus.BAD_REQUEST,
        );
      }

      console.log(
        'Correo electrónico del cliente:',
        session.metadata.userEmail,
      );

      const user = await this.usersRepository.findOne({
        where: { email: session.metadata.userEmail },
      });

      if (!user) {
        console.error(
          'No se encontró el usuario con el email:',
          session.metadata.userEmail,
        );
        throw new HttpException(
          'No se encontró el usuario con el email proporcionado',
          HttpStatus.NOT_FOUND,
        );
      }

      const membership = await this.membershipsCustomRepository.findOne({
        where: { stripePriceId: session.metadata.stripePriceId },
      });

      if (!membership) {
        console.error(
          'No se encontró una membresía con el stripePriceId:',
          session.metadata.stripePriceId,
        );
        throw new HttpException(
          `No se encontró una membresía con el stripePriceId: ${session.metadata.stripePriceId}`,
          HttpStatus.NOT_FOUND,
        );
      }

      const paymentData = {
        user_id: user.id,
        membership_id: membership.id,
        payment_date: new Date(),
        amount: session.amount_total / 100,
        payment_method: session.payment_method_types[0],
        status: 'completed',
        transaction_id: session.id,
      };

      await this.paymentsRepository.save(paymentData);

      user.membership_status = MembershipStatus.Active;
      user.roles = Role.Associate;

      const updatedUser = await this.usersCustomRepository.updateUser(
        user.id,
        user,
      ); // Aquí usamos `save`, que actualizará el usuario correctamente

      await this.emailService.sendMembershipNotificationEmail(
        user.email,
        user.name,
        membership.name,
      );
      console.log({
        message: `Pago procesado exitosamente. El estado de la membresía del usuario ahora es: ${updatedUser.membership_status}`,
        paymentData,
        userData: updatedUser,
        roles: updatedUser.roles,
        membershipStatus: updatedUser.membership_status,
      });

      return {
        message: `Pago procesado exitosamente. El estado de la membresía del usuario ahora es: ${updatedUser.membership_status}`,
        paymentData,
        userData: updatedUser,
        roles: updatedUser.roles,
        membershipStatus: updatedUser.membership_status,
      };
    } catch (error) {
      console.error('Error procesando el pago:', error);
      throw new HttpException(
        `Error procesando el pago: ${error.message}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  async checkPaymentStatus(sessionId: string) {
    if (!sessionId) {
      throw new HttpException(
        'sessionId no proporcionado',
        HttpStatus.BAD_REQUEST,
      );
    }

    try {
      const session = await stripe.checkout.sessions.retrieve(sessionId);

      if (!session) {
        throw new HttpException('Sesión no encontrada', HttpStatus.NOT_FOUND);
      }

      return {
        status: session.payment_status,
        message:
          session.payment_status === 'paid'
            ? 'Pago exitoso'
            : 'El pago no se completó',
        sessionId: session.id,
        amount: session.amount_total / 100,
        customer: session.customer,
      };
    } catch (error) {
      console.error('Error verificando el estado del pago:', error);
      throw new HttpException(
        'Error verificando el estado del pago',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  async getAllPayments(
    page: number,
    limit: number,
    amount?: string,
    specificDate?: string,
    status?: string,
    orderDirection: 'ASC' | 'DESC' = 'ASC',
  ) {
    const parsedDate = specificDate ? new Date(specificDate) : undefined;

    return await this.paymentsCustomRepository.getAllPayments(
      page,
      limit,
      amount,
      parsedDate,
      status,
      orderDirection,
    );
  }

  async getPaymentsById(id: string) {
    return await this.paymentsCustomRepository.getPaymentsById(id);
  }
}
